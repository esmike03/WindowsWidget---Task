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

/* ── layout ──────────────────────────────────────────────────────────── */

/** The window is only ever as tall as it needs to be. */
function fit() {
  if (el.out.hidden) return api.resize(BAR_H);
  const head = 32;
  const room = MAX_H - BAR_H - BUBBLE_GAP - head;
  const content = Math.min(room, el.answer.scrollHeight + 12);
  api.resize(BAR_H + BUBBLE_GAP + head + content);
}

function showOut({ status, text, error, working, capture = includeScreenshot }) {
  el.out.hidden = false;
  el.out.classList.toggle('is-error', !!error);
  el.spin.hidden = !working;
  el.outIcon.hidden = !!working;
  el.outIcon.querySelector('use').setAttribute('href', capture ? '#a-camera' : '#a-spark');
  el.status.textContent = status;
  el.copy.hidden = !text;

  fullText = text || error || '';
  el.answer.textContent = fullText;
  el.answer.scrollTop = 0;

  // The bubble uses all available screen space; longer replies scroll inside it.
  fit();
}

function hideOut() {
  el.out.hidden = true;
  fullText = '';
  el.answer.textContent = '';
  fit();
}

/* ── send ────────────────────────────────────────────────────────────── */

function setBusy(on) {
  busy = on;
  el.send.disabled = on;
  el.prompt.disabled = on;
}

function renderCapturePreference() {
  el.prompt.placeholder = includeScreenshot ? 'Ask about this screen…' : 'Ask ChatGPT or Claude…';
  el.send.title = includeScreenshot
    ? 'Capture this screen and send (Enter)'
    : 'Send prompt (Enter)';
}

async function submit() {
  const text = el.prompt.value.trim();
  if (!text || busy) return;

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
    showOut({ status: label, text: res.text, capture });
    el.prompt.value = '';
  } else {
    showOut({
      status: 'Failed',
      error: (res && res.error) || 'Something went wrong.',
      capture,
    });
  }
  el.prompt.focus();
}

/* ── events ──────────────────────────────────────────────────────────── */

el.send.addEventListener('click', submit);

el.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

el.target.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-target]');
  if (!btn) return;
  target = btn.dataset.target;
  el.target.dataset.on = target;
  document.querySelectorAll('[data-target]').forEach((b) => b.classList.toggle('is-on', b.dataset.target === target));
  api.settings.set({ askTarget: target });
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

el.clear.addEventListener('click', hideOut);
el.close.addEventListener('click', () => api.hide());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
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
  renderCapturePreference();
});

/* ── boot ────────────────────────────────────────────────────────────── */

(async function boot() {
  try {
    const s = await api.settings.get();
    if (s.askTarget === 'claude' || s.askTarget === 'chatgpt') target = s.askTarget;
    includeScreenshot = !!s.askIncludeScreenshot;
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
