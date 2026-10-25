'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Quick-capture bar.

   Type a line, press Enter, it lands in Sidenote. The panel never opens.
   Enter saves and dismisses; Shift+Enter saves and stays open for another.
   ═══════════════════════════════════════════════════════════════════════ */

const api = window.captureApi;
const { parseWhen } = window.SidenoteParse;
const $ = (sel) => document.querySelector(sel);

const el = {
  html: document.documentElement,
  bar: $('#bar'),
  kind: $('#kind'),
  text: $('#text'),
  add: $('#add'),
  close: $('#close'),
  hint: $('#hint'),
  hintIcon: $('#hintIcon'),
  hintText: $('#hintText'),
};

const BAR_H = 52;
const HINT_H = 41; // hint row plus the gap above it
const CONFIRM_MS = 900;

// 'auto' means "whatever the text implies"; clicking either button pins it.
let kindOverride = null;
let confirmTimer = null;
let closeTimer = null;

/* ── layout ──────────────────────────────────────────────────────────── */

function fit() {
  api.resize(el.hint.hidden ? BAR_H : BAR_H + HINT_H);
}

api.onLayout(({ direction }) => {
  el.html.dataset.layout = direction === 'above' ? 'above' : 'below';
});

/* ── what will be created ────────────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function describeWhen(at) {
  const when = new Date(at);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000);

  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/\s/g, ' ');
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${when.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return `${when.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** The bucket this line lands in: what the text implies, unless pinned. */
function currentKind(parsed) {
  if (kindOverride) return kindOverride;
  return parsed.at != null ? 'event' : 'task';
}

function renderKind(kind) {
  el.kind.dataset.on = kind;
  for (const button of el.kind.querySelectorAll('button')) {
    button.classList.toggle('is-on', button.dataset.kind === kind);
  }
}

function preview() {
  // A confirmation is showing; leave it alone until it clears.
  if (confirmTimer) return;

  const raw = el.text.value.trim();
  const parsed = parseWhen(raw);
  const kind = currentKind(parsed);
  renderKind(kind);

  el.hint.classList.remove('is-ok', 'is-bad');
  el.add.disabled = !raw;

  if (!raw) {
    el.hint.hidden = true;
    fit();
    return;
  }

  const title = parsed.title || raw;
  const noun = kind === 'event' ? 'Event' : 'Task';
  el.hintIcon.firstElementChild.setAttribute('href', parsed.at != null ? '#c-clock' : '#c-circle');
  el.hintText.innerHTML =
    parsed.at != null
      ? `${noun} · <em>${esc(title)}</em> · ${esc(describeWhen(parsed.at))}`
      : `${noun} · <em>${esc(title)}</em> · no date`;
  el.hint.hidden = false;
  fit();
}

function flash(message, tone) {
  clearTimeout(confirmTimer);
  el.hint.classList.remove('is-ok', 'is-bad');
  if (tone) el.hint.classList.add(tone);
  el.hintIcon.firstElementChild.setAttribute('href', tone === 'is-ok' ? '#c-check' : '#c-circle');
  el.hintText.textContent = message;
  el.hint.hidden = false;
  fit();
  confirmTimer = setTimeout(() => {
    confirmTimer = null;
    preview();
  }, CONFIRM_MS);
}

/* ── saving ──────────────────────────────────────────────────────────── */

async function submit({ keepOpen }) {
  const raw = el.text.value.trim();
  if (!raw) {
    reject();
    return;
  }

  const parsed = parseWhen(raw);
  const kind = currentKind(parsed);
  const title = parsed.title || raw;

  el.add.disabled = true;
  const result = await api.add({ kind, title, at: parsed.at });
  el.add.disabled = false;

  if (!result || !result.ok) {
    flash(result?.error || 'Could not save that', 'is-bad');
    return;
  }

  el.text.value = '';
  kindOverride = null;

  if (keepOpen) {
    flash(`Added · ${title}`, 'is-ok');
    el.text.focus();
    return;
  }

  // Let the confirmation register before the window goes away.
  flash(`Added · ${title}`, 'is-ok');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => dismiss(), CONFIRM_MS);
}

function reject() {
  el.bar.classList.remove('is-bad');
  void el.bar.offsetWidth; // restart the animation
  el.bar.classList.add('is-bad');
  el.text.focus();
}

function dismiss() {
  clearTimeout(closeTimer);
  clearTimeout(confirmTimer);
  closeTimer = null;
  confirmTimer = null;
  el.text.value = '';
  kindOverride = null;
  el.hint.hidden = true;
  el.hint.classList.remove('is-ok', 'is-bad');
  fit();
  api.hide();
}

/* ── events ──────────────────────────────────────────────────────────── */

el.text.addEventListener('input', () => {
  clearTimeout(closeTimer);
  closeTimer = null;
  preview();
});

el.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit({ keepOpen: e.shiftKey });
  } else if (e.key === 'Tab') {
    // Tab flips the bucket rather than moving focus — there is nowhere else
    // in this window worth tabbing to.
    e.preventDefault();
    kindOverride = currentKind(parseWhen(el.text.value.trim())) === 'event' ? 'task' : 'event';
    preview();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    dismiss();
  }
});

el.kind.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-kind]');
  if (!button) return;
  kindOverride = button.dataset.kind;
  preview();
  el.text.focus();
});

el.add.addEventListener('click', () => submit({ keepOpen: false }));
el.close.addEventListener('click', dismiss);

api.onFocus(() => {
  clearTimeout(closeTimer);
  closeTimer = null;
  el.text.focus();
  el.text.select();
  preview();
});

api.onTheme(({ resolved }) => {
  el.html.dataset.theme = resolved;
});

/* ── boot ────────────────────────────────────────────────────────────── */

(async function boot() {
  try {
    const settings = await api.settings.get();
    const theme = settings?.theme === 'dark' || settings?.theme === 'light' ? settings.theme : null;
    if (theme) el.html.dataset.theme = theme;
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches) el.html.dataset.theme = 'dark';
  } catch (_) {
    /* theme is cosmetic — never block capture on it */
  }
  el.add.disabled = true;
  fit();
  el.text.focus();
})();
