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
  more: $('#more'),
  copy: $('#copy'),
  clear: $('#clear'),
};

const BAR_H = 58;
const MAX_H = 520;
const CLAMP_H = 190; // collapsed answer height

let target = 'chatgpt';
let busy = false;
let fullText = '';
let expanded = false;

/* ── layout ──────────────────────────────────────────────────────────── */

/** The window is only ever as tall as it needs to be. */
function fit() {
  if (el.out.hidden) return api.resize(BAR_H);
  const head = 32;
  const moreH = el.more.hidden ? 0 : 36;
  const room = MAX_H - BAR_H - head - moreH;
  // Collapsed shows a short viewport; expanded grows to the content, capped.
  const content = Math.min(room, el.answer.scrollHeight + 12);
  const body = expanded ? content : Math.min(CLAMP_H, content);
  api.resize(BAR_H + head + body + moreH);
}

/** Single place that renders `expanded`, so the label can never disagree with it. */
function renderMore() {
  el.answer.classList.toggle('is-clamped', !expanded && !el.more.hidden);
  el.more.classList.toggle('is-open', expanded);
  $('#more span').textContent = expanded ? 'Show less' : 'Show more';
  fit();
}

function showOut({ status, text, error, working }) {
  el.out.hidden = false;
  el.out.classList.toggle('is-error', !!error);
  el.spin.hidden = !working;
  el.outIcon.hidden = !!working;
  el.status.textContent = status;
  el.copy.hidden = !text;

  fullText = text || error || '';
  el.answer.textContent = fullText;
  el.answer.scrollTop = 0;

  // Every new answer starts collapsed, whatever the last one was left as.
  expanded = false;
  el.more.hidden = false;
  el.more.blur();
  renderMore();

  // Measure once laid out: only offer the toggle if there is more to see.
  requestAnimationFrame(() => {
    const overflows = el.answer.scrollHeight > CLAMP_H - 12;
    el.more.hidden = !overflows;
    renderMore();
  });
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

async function submit() {
  const text = el.prompt.value.trim();
  if (!text || busy) return;

  setBusy(true);
  showOut({ status: 'Capturing this screen…', working: true, text: '' });

  let res;
  try {
    res = await api.submit({ prompt: text, target });
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  setBusy(false);

  if (res && res.ok) {
    const label = target === 'claude' ? 'Claude' : 'ChatGPT';
    showOut({ status: label, text: res.text });
    el.prompt.value = '';
  } else {
    showOut({
      status: 'Failed',
      error: (res && res.error) || 'Something went wrong.',
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

el.more.addEventListener('click', () => {
  expanded = !expanded;
  renderMore();
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

api.onTheme(({ resolved }) => {
  el.html.dataset.theme = resolved;
});

/* ── boot ────────────────────────────────────────────────────────────── */

(async function boot() {
  try {
    const s = await api.settings.get();
    if (s.askTarget === 'claude' || s.askTarget === 'chatgpt') target = s.askTarget;
    el.target.dataset.on = target;
    document.querySelectorAll('[data-target]').forEach((b) => b.classList.toggle('is-on', b.dataset.target === target));
    el.html.dataset.theme = s.theme === 'dark' ? 'dark' : s.theme === 'light' ? 'light' : el.html.dataset.theme;
  } catch (_) {
    /* defaults are fine */
  }
  fit();
  el.prompt.focus();
})();
