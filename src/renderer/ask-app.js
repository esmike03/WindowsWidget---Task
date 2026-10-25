'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Sidenote Ask bar — floating prompt + screenshot, answer in place.
   ═══════════════════════════════════════════════════════════════════════ */

const api = window.ask;
const $ = (s) => document.querySelector(s);

const el = {
  html: document.documentElement,
  bar: $('#bar'),
  target: $('#target'),
  prompt: $('#prompt'),
  send: $('#send'),
  stop: $('#stop'),
  mic: $('#mic'),
  newChat: $('#newChat'),
  outFoot: $('#outFoot'),
  outAction: $('#outAction'),
  outChanges: $('#outChanges'),
  close: $('#close'),
  out: $('#out'),
  spin: $('#spin'),
  outIcon: $('#outIcon'),
  status: $('#status'),
  answer: $('#answer'),
  copy: $('#copy'),
  clear: $('#clear'),
};

const BAR_H = 48;
const MAX_H = 480;
const BUBBLE_GAP = 8;

let target = 'chatgpt';
let includeScreenshot = false;
let busy = false;
let fullText = '';
let inChat = false; // a ChatGPT conversation is open; follow-ups continue it
let outActionFn = null;
let voiceAutoSend = true;
let listening = false;
let voiceIdle = null;
let voiceGiveUp = null;
let voiceStartValue = '';

/* ── reply formatting ────────────────────────────────────────────────── */

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g;

/** Inline Markdown → DOM nodes. Built with text nodes only, never innerHTML. */
function appendInline(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    let node;
    if (tok.startsWith('**')) {
      node = document.createElement('strong');
      node.textContent = tok.slice(2, -2);
    } else if (tok.startsWith('`')) {
      node = document.createElement('code');
      node.textContent = tok.slice(1, -1);
    } else {
      // [label](target): file paths and URLs aren't clickable here, so show
      // the label and keep the target as a tooltip.
      const split = tok.indexOf('](');
      node = document.createElement('span');
      node.className = 'ref';
      node.textContent = tok.slice(1, split);
      node.title = tok.slice(split + 2, -1);
    }
    parent.append(node);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderReply(container, text) {
  container.textContent = '';
  const parts = String(text).split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      pre.textContent = part.replace(/\n$/, '');
      container.append(pre);
    } else {
      const clean = part.replace(/^#{1,6}\s+(.*)$/gm, '**$1**');
      appendInline(container, clean);
    }
  });
}

/* ── layout ──────────────────────────────────────────────────────────── */

/** The window is only ever as tall as it needs to be. */
function fit() {
  if (el.out.hidden) return api.resize(BAR_H);
  const head = 32;
  const foot = el.outFoot.hidden ? 0 : el.outFoot.offsetHeight;
  const room = MAX_H - BAR_H - BUBBLE_GAP - head - foot;
  const content = Math.min(room, el.answer.scrollHeight + 12);
  api.resize(BAR_H + BUBBLE_GAP + head + content + foot);
}

function showOut({ status, text, error, working, capture = includeScreenshot, action = null, changes = [] }) {
  el.out.hidden = false;
  el.out.classList.toggle('is-error', !!error);
  el.spin.hidden = !working;
  el.outIcon.hidden = !!working;
  el.outIcon.querySelector('use').setAttribute('href', capture ? '#a-camera' : '#a-spark');
  el.status.textContent = status;
  el.copy.hidden = !text;
  el.newChat.hidden = working || !inChat;
  outActionFn = action ? action.run : null;
  el.outFoot.hidden = !action && !changes.length;
  el.outAction.hidden = !action;
  el.outAction.textContent = action ? action.label : '';
  el.outChanges.textContent = '';
  for (const c of changes) {
    const li = document.createElement('li');
    li.textContent = c.text;
    if (c.bad) li.className = 'is-bad';
    el.outChanges.append(li);
  }

  fullText = text || error || '';
  if (text) {
    renderReply(el.answer, text);
    fullText = el.answer.textContent; // copy gives clean text, not Markdown
  } else {
    el.answer.textContent = fullText;
  }
  el.answer.scrollTop = 0;

  // The bubble uses all available screen space; longer replies scroll inside it.
  fit();
}

function hideOut() {
  if (busy) return;
  el.out.hidden = true;
  fullText = '';
  el.answer.textContent = '';
  fit();
}

/* ── send ────────────────────────────────────────────────────────────── */

function setBusy(on) {
  busy = on;
  el.prompt.disabled = on;
  // ChatGPT runs as a local process and can be stopped; Claude can't.
  const stoppable = on && target === 'chatgpt';
  el.send.hidden = stoppable;
  el.stop.hidden = !stoppable;
  el.send.disabled = on;
}

function renderCapturePreference() {
  const who = target === 'claude' ? 'Claude' : 'ChatGPT';
  el.prompt.placeholder = includeScreenshot
    ? `Ask ${who} about this screen…`
    : target === 'chatgpt'
      ? inChat ? 'Reply to ChatGPT…' : 'Ask or say anything…'
      : 'Ask Claude…';
  el.send.title = includeScreenshot
    ? 'Capture this screen and send (Enter)'
    : 'Send prompt (Enter)';
}

async function submit() {
  const text = el.prompt.value.trim();
  if (!text || busy) return;
  stopVoice();

  const capture = includeScreenshot;
  setBusy(true);
  showOut({
    status: capture ? 'Capturing this screen…' : 'Sending prompt…',
    working: true,
    text: '',
    capture,
  });

  let res;
  try {
    res = await api.submit({ prompt: text, target });
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  setBusy(false);

  if (res && res.ok) {
    const label = target === 'claude' ? 'Claude' : 'ChatGPT';
    if (target === 'chatgpt') inChat = true;
    const changes = [
      ...(res.applied || []).map((text) => ({ text })),
      ...(res.skipped || []).map((text) => ({ text: `Skipped: ${text}`, bad: true })),
    ];
    showOut({
      status: label,
      text: res.text,
      capture,
      changes,
      action: res.undoable ? { label: 'Undo', run: undoChanges } : null,
    });
    el.prompt.value = '';
  } else if (res && res.stopped) {
    showOut({ status: 'Stopped', error: 'You stopped this answer.', capture });
  } else {
    const error = (res && res.error) || 'Something went wrong.';
    const signIn = target === 'chatgpt' && /sign in|signed in|install/i.test(error);
    showOut({
      status: 'Failed',
      error,
      capture,
      action: signIn && !/install/i.test(error) ? { label: 'Sign in with ChatGPT', run: signInChatGpt } : null,
    });
  }
  renderCapturePreference();
  el.prompt.focus();
}

api.onLoginCode(({ code, browser }) => {
  if (!busy) return;
  const where = browser ? browser[0].toUpperCase() + browser.slice(1) : 'your browser';
  el.answer.textContent = `The ChatGPT sign-in page opened in ${where}. Sign in there and enter this code:\n\n${code}`;
  fit();
});

async function signInChatGpt() {
  busy = true;
  showOut({ status: 'Signing in…', working: true, text: '' });
  el.answer.textContent = 'Opening the ChatGPT sign-in page…';
  fit();
  const res = await api.codexLogin().catch((e) => ({ ok: false, error: e.message }));
  busy = false;
  if (res && res.ok) showOut({ status: 'Signed in', text: 'ChatGPT is connected. Ask your question again.' });
  else showOut({ status: 'Failed', error: (res && res.error) || 'Sign-in was not completed.' });
}

async function undoChanges() {
  const res = await api.undo().catch(() => null);
  el.outAction.hidden = true;
  el.outChanges.textContent = '';
  const li = document.createElement('li');
  li.textContent = res && res.ok ? 'Changes undone.' : (res && res.error) || 'Could not undo.';
  el.outChanges.append(li);
  fit();
}

/* ── voice ───────────────────────────────────────────────────────────── */

const VOICE_SEND_AFTER_MS = 2200; // quiet this long after the last word → send
const VOICE_GIVE_UP_MS = 25_000; // nothing heard → stop listening

function stopVoice() {
  listening = false;
  clearTimeout(voiceIdle);
  clearTimeout(voiceGiveUp);
  el.mic.classList.remove('is-on');
  el.bar.classList.remove('is-listening');
}

/** Focus the input and switch on Windows voice typing (Win+H) for it. */
async function startVoice() {
  if (busy) return;
  if (listening) {
    stopVoice();
    await api.voiceKey(); // Win+H again closes voice typing
    return;
  }
  el.prompt.focus();
  const ok = await api.voiceKey().catch(() => false);
  if (!ok) {
    showOut({
      status: 'Voice',
      error: 'Voice typing could not start. Click the input and press Win+H, or turn on voice typing in Windows Settings → Time & language → Speech.',
    });
    return;
  }
  listening = true;
  voiceStartValue = el.prompt.value;
  el.mic.classList.add('is-on');
  el.bar.classList.add('is-listening');
  clearTimeout(voiceGiveUp);
  voiceGiveUp = setTimeout(stopVoice, VOICE_GIVE_UP_MS);
}

el.prompt.addEventListener('input', () => {
  if (!listening) return;
  clearTimeout(voiceGiveUp);
  voiceGiveUp = setTimeout(stopVoice, VOICE_GIVE_UP_MS);
  clearTimeout(voiceIdle);
  if (!voiceAutoSend) return;
  voiceIdle = setTimeout(() => {
    const value = el.prompt.value.trim();
    if (!listening || !value || value === voiceStartValue.trim()) return;
    stopVoice();
    submit();
  }, VOICE_SEND_AFTER_MS);
});

el.mic.addEventListener('click', startVoice);
api.onVoice(() => startVoice());

function startNewChat() {
  inChat = false;
  api.newChat();
  hideOut();
  renderCapturePreference();
  el.prompt.focus();
}

/* ── events ──────────────────────────────────────────────────────────── */

el.stop.addEventListener('click', () => api.cancel());
el.newChat.addEventListener('click', startNewChat);
el.outAction.addEventListener('click', () => outActionFn && outActionFn());

el.send.addEventListener('click', submit);

el.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

el.target.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-target]');
  if (!btn || busy) return;
  target = btn.dataset.target;
  el.target.dataset.on = target;
  document.querySelectorAll('[data-target]').forEach((b) => b.classList.toggle('is-on', b.dataset.target === target));
  api.settings.set({ askTarget: target });
  renderCapturePreference();
  el.prompt.focus();
});

el.copy.addEventListener('click', async () => {
  if (!fullText) return;
  try {
    await navigator.clipboard.writeText(fullText);
    const prev = el.status.textContent;
    el.status.textContent = 'Copied';
    setTimeout(() => {
      el.status.textContent = prev;
    }, 1200);
  } catch (_) {
    /* clipboard denied — nothing useful to say */
  }
});

el.clear.addEventListener('click', () => (busy && target === 'chatgpt' ? api.cancel() : hideOut()));
el.close.addEventListener('click', () => api.hide());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (listening) return stopVoice();
    if (busy) return target === 'chatgpt' ? api.cancel() : undefined;
    if (!el.out.hidden) return hideOut();
    api.hide();
  }
});

api.onFocus(() => {
  el.prompt.focus();
  el.prompt.select();
});

api.onStatus((text) => {
  if (busy) el.status.textContent = text;
});

api.onLayout(({ direction }) => {
  el.html.dataset.layout = direction === 'above' ? 'above' : 'below';
});

api.onTheme(({ resolved }) => {
  el.html.dataset.theme = resolved;
});

api.settings.onChange((next) => {
  includeScreenshot = !!next.askIncludeScreenshot;
  voiceAutoSend = next.askVoiceAutoSend !== false;
  renderCapturePreference();
});

/* ── boot ────────────────────────────────────────────────────────────── */

(async function boot() {
  try {
    const s = await api.settings.get();
    if (s.askTarget === 'claude' || s.askTarget === 'chatgpt') target = s.askTarget;
    includeScreenshot = !!s.askIncludeScreenshot;
    voiceAutoSend = s.askVoiceAutoSend !== false;
    el.target.dataset.on = target;
    document.querySelectorAll('[data-target]').forEach((b) => b.classList.toggle('is-on', b.dataset.target === target));
    el.html.dataset.theme = s.theme === 'dark' ? 'dark' : s.theme === 'light' ? 'light' : el.html.dataset.theme;
  } catch (_) {
    /* defaults are fine */
  }
  renderCapturePreference();
  fit();
  el.prompt.focus();
})();
