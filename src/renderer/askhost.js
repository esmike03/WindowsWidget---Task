'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Ask host — offscreen driver for the chat sites.

   The Ask bar used to borrow the panel's webviews, which meant the panel
   had to be expanded and the pane opened for every question. This window
   owns its own webviews at a fixed desktop size instead, so asking never
   disturbs whatever the user has on screen.
   ═══════════════════════════════════════════════════════════════════════ */

const api = window.askHost;
const AI_PARTITION = 'persist:sidenote-ai';
const host = document.getElementById('host');
const views = new Map(); // target -> <webview>

function onceEvent(node, name, timeoutMs) {
  return new Promise((res) => {
    const done = () => {
      clearTimeout(timer);
      node.removeEventListener(name, done);
      res();
    };
    const timer = setTimeout(done, timeoutMs);
    node.addEventListener(name, done);
  });
}

/** One webview per site, kept alive so the session and history persist. */
function ensureView(target, url) {
  const existing = views.get(target);
  if (existing) return existing;

  const view = document.createElement('webview');
  view.setAttribute('partition', AI_PARTITION);
  view.setAttribute('allowpopups', '');
  view.setAttribute('src', url);
  view.addEventListener('dom-ready', () => {
    view.dataset.ready = '1';
  });

  host.appendChild(view);
  views.set(target, view);
  return view;
}

async function run({ id, prompt, target, image, url }) {
  let answered = false;
  const reply = (result) => {
    if (answered) return;
    answered = true;
    api.result(id, result);
  };

  try {
    if (!url) return reply({ ok: false, error: `No address configured for "${target}".` });

    const view = ensureView(target, url);

    if (view.dataset.ready !== '1') {
      api.progress('Opening the chat…');
      await onceEvent(view, 'dom-ready', 30_000);
    }
    if (view.dataset.ready !== '1') {
      return reply({ ok: false, error: 'The chat page did not finish loading.' });
    }
    try {
      if (view.isLoading()) {
        api.progress('Loading the chat…');
        await onceEvent(view, 'did-stop-loading', 30_000);
      }
    } catch (_) {
      /* not attached yet; the ready flag above already gated us */
    }

    api.progress('Attaching the screenshot…');
    const script = window.SidenoteInject.buildAskScript({ target, prompt, image, budgetMs: 90_000 });
    const result = await view.executeJavaScript(script, true);
    reply(
      result && typeof result === 'object'
        ? result
        : { ok: false, error: 'No result came back from the page.' }
    );
  } catch (err) {
    reply({ ok: false, error: `Page automation failed: ${(err && err.message) || err}` });
  }
}

api.onRun((job) => {
  run(job).catch((err) => {
    api.result(job.id, { ok: false, error: `Ask failed: ${(err && err.message) || err}` });
  });
});

api.ready();
