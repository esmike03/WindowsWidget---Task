'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Page automation for the Ask bar.

   This drives the chat site's own UI: it drops the screenshot into the
   composer, types the prompt, clicks send and reads the reply back out of
   the DOM. That means it is coupled to markup we do not control and will
   break when either site is redesigned — so every lookup goes through a
   list of candidate selectors, and a miss returns a named error rather
   than failing quietly.

   The function below is stringified and handed to webview.executeJavaScript,
   so it must be entirely self-contained: no closures over this file.
   ═══════════════════════════════════════════════════════════════════════ */

const SELECTORS = {
  chatgpt: {
    composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[data-id]'],
    fileInput: ['input[type="file"]'],
    send: [
      '[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
    ],
    stop: ['[data-testid="stop-button"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop streaming"]'],
    answer: ['[data-message-author-role="assistant"]'],
    loginHint: ['[data-testid="login-button"]', 'button[data-testid="mobile-login-button"]'],
  },
  claude: {
    composer: ['div[contenteditable="true"].ProseMirror', 'div[enterkeyhint][contenteditable="true"]', 'div[contenteditable="true"]'],
    fileInput: ['input[type="file"]'],
    send: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[type="submit"]:not([disabled])',
    ],
    stop: ['button[aria-label="Stop response"]', 'button[aria-label="Stop Response"]'],
    answer: ['[data-testid="assistant-message"]', 'div.font-claude-response', 'div.font-claude-message'],
    loginHint: ['a[href*="/login"]'],
  },
};

/**
 * Runs inside the chat page. Returns { ok, text } or { ok:false, error, stage }.
 * `cfg` = { prompt, image (base64 png), sel (the selector table), budgetMs }
 */
function sidenoteAskPage(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (list) => {
    for (const s of list) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);

  async function waitFor(fn, ms, step) {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) return null;
      await sleep(step || 200);
    }
  }

  async function run() {
    const sel = cfg.sel;

    const composer = await waitFor(() => pick(sel.composer), 12000);
    if (!composer) {
      const login = pick(sel.loginHint);
      return {
        ok: false,
        stage: 'composer',
        error: login
          ? 'That site is showing a signed-out page. Open the pane and sign in first.'
          : 'Could not find the message box on the page. The site layout has probably changed.',
      };
    }

    // ── attach the screenshot ──────────────────────────────────────────
    let attached = false;
    if (cfg.image) {
      const bin = atob(cfg.image);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'screenshot.png', { type: 'image/png' });

      // A real file input is the most reliable route when the site has one.
      const input = pick(sel.fileInput);
      if (input) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          attached = true;
        } catch (_) {
          attached = false;
        }
      }
      // Otherwise fake a paste onto the composer, which every rich editor handles.
      if (!attached) {
        try {
          const dt2 = new DataTransfer();
          dt2.items.add(file);
          composer.focus();
          composer.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true })
          );
          attached = true;
        } catch (err) {
          return { ok: false, stage: 'attach', error: 'Could not attach the screenshot: ' + err.message };
        }
      }
    }

    // ── type the prompt ────────────────────────────────────────────────
    composer.focus();
    let typed = false;
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(
        composer.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(composer, cfg.prompt);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      typed = true;
    } else {
      // contenteditable: execCommand is deprecated but is still the only way to
      // insert text that React-backed editors (ProseMirror et al) actually see.
      typed = document.execCommand('insertText', false, cfg.prompt);
      if (!typed) {
        composer.textContent = cfg.prompt;
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: cfg.prompt }));
        typed = true;
      }
    }
    if (!typed) return { ok: false, stage: 'type', error: 'Could not type into the message box.' };

    // Uploads disable the send button until they finish.
    await sleep(attached ? 1200 : 250);
    const sendBtn = await waitFor(() => {
      const b = pick(sel.send);
      return visible(b) && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, attached ? 45000 : 8000);

    if (!sendBtn) {
      return {
        ok: false,
        stage: 'send',
        error: attached
          ? 'The send button never became available — the screenshot upload may have failed.'
          : 'Could not find an enabled send button.',
      };
    }

    const before = document.querySelectorAll(sel.answer.join(',')).length;
    sendBtn.click();

    // ── wait for the reply ─────────────────────────────────────────────
    const grown = await waitFor(
      () => document.querySelectorAll(sel.answer.join(',')).length > before,
      60000,
      300
    );
    if (!grown) return { ok: false, stage: 'reply', error: 'No reply appeared. The message may not have sent.' };

    const deadline = Date.now() + Math.max(10000, cfg.budgetMs || 90000);
    let last = '';
    let stableFor = 0;
    for (;;) {
      const nodes = document.querySelectorAll(sel.answer.join(','));
      const node = nodes[nodes.length - 1];
      const now = node ? (node.innerText || '').trim() : '';
      const streaming = !!pick(sel.stop);

      if (now === last && now) stableFor += 400;
      else stableFor = 0;
      last = now;

      // Done when the stop button is gone and the text has settled.
      if (!streaming && now && stableFor >= 1200) break;
      if (Date.now() > deadline) break;
      await sleep(400);
    }

    if (!last) return { ok: false, stage: 'read', error: 'The reply came back empty.' };
    // innerText of a chat bubble carries the gaps between its block elements,
    // which a pre-wrap bubble would render as dead space.
    const tidy = last.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { ok: true, text: tidy, attached: attached };
  }

  return run().catch((err) => ({ ok: false, stage: 'run', error: String((err && err.message) || err) }));
}

/**
 * Builds the source string for webview.executeJavaScript. Kept as a real
 * function above so it is syntax-checked with the rest of the file rather
 * than living in an unparsed template literal.
 */
function buildAskScript({ target, prompt, image, budgetMs }) {
  const sel = SELECTORS[target];
  if (!sel) throw new Error(`No automation profile for "${target}"`);
  const cfg = JSON.stringify({ prompt, image, sel, budgetMs: budgetMs || 90000 });
  return `(${sidenoteAskPage.toString()})(${cfg})`;
}

// The renderer loads this as a classic script, so publish on the global.
window.SidenoteInject = { buildAskScript, SELECTORS };
