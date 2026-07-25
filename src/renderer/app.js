'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Sidenote renderer
   Item = { id, kind:'event'|'task', title, at:number|null, done, doneAt,
            archived, archivedAt, createdAt, notified }
   ═══════════════════════════════════════════════════════════════════════ */

const api = window.sidenote;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const el = {
  html: document.documentElement,
  tab: $('#tab'),
  tabBadge: $('#tabBadge'),
  tabDot: $('#tabDot'),
  panel: $('#panel'),
  grip: $('#grip'),
  weekday: $('#hWeekday'),
  date: $('#hDate'),
  sub: $('#hSub'),
  seg: $('#seg'),
  cSchedule: $('#cSchedule'),
  cNotes: $('#cNotes'),
  scroller: $('#scroller'),
  list: $('#list'),
  empty: $('#empty'),
  form: $('#form'),
  input: $('#input'),
  parsed: $('#parsed'),
  chipWhen: $('#chipWhen'),
  hint: $('#hint'),
  pop: $('#when'),
  popInput: $('#whenInput'),
  sheet: $('#sheet'),
  archiveList: $('#archiveList'),
  screenInfo: $('#screenInfo'),
  toast: $('#toast'),
  toastText: $('#toastText'),
  toastUndo: $('#toastUndo'),
  ai: $('#ai'),
  aiSeg: $('#aiSeg'),
  aiBody: $('#aiBody'),
  aiState: $('#aiState'),
  aiStateText: $('#aiStateText'),
  aiNote: $('#aiNote'),
};

let data = { version: 1, items: [] };
let settings = {};
let view = 'schedule';
let manualWhen = null; // { at: number|null } — overrides text parsing until submit
let editingId = null;
let seenIds = new Set();

const COMPLETE_DELAY = 1500; // strike-through dwell before the item leaves
const pending = new Map(); // id -> { timer, prevKind }
let toastTimer = null;
let undoAction = null;

const DAY = 86_400_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

/* ── helpers ─────────────────────────────────────────────────────────── */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 2-digit hours keep the clock column the same width on every row.
const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/\s/g, ' ');

function relative(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  let out;
  if (abs < 60_000) out = 'now';
  else if (abs < 3_600_000) out = `${Math.round(abs / 60_000)}m`;
  else if (abs < DAY) out = `${Math.round(abs / 3_600_000)}h`;
  else if (abs < DAY * 7) out = `${Math.round(abs / DAY)}d`;
  else out = `${Math.round(abs / (DAY * 7))}w`;
  if (out === 'now') return 'now';
  return past ? `${out} ago` : `in ${out}`;
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── natural-language date parsing ───────────────────────────────────── */

/**
 * Pulls a date and/or a time out of free text and returns the remaining
 * title. Deliberately conservative: if nothing looks like a date we return
 * `at: null` rather than guessing.
 */
function parseWhen(raw) {
  let s = ` ${raw} `;
  const now = new Date();
  let dayMs = null;
  let time = null; // { h, m }
  let relMs = null;

  const cut = (m) => {
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
  };
  const take = (re) => {
    const m = s.match(re);
    if (m) cut(m);
    return m;
  };

  // "in 30m" / "in 2 hours" / "in 3 days"
  const rel = take(/\bin\s+(\d{1,3})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)\b/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const u = rel[2].toLowerCase()[0];
    const mult = u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : u === 'd' ? DAY : DAY * 7;
    relMs = Date.now() + n * mult;
  }

  if (relMs === null) {
    // today / tonight / tomorrow / yesterday
    const kw = take(/\b(today|tonight|tomorrow|tmrw?|yesterday)\b/i);
    if (kw) {
      const k = kw[1].toLowerCase();
      const base = startOfDay(Date.now());
      if (k === 'today') dayMs = base;
      else if (k === 'tonight') {
        dayMs = base;
        time = { h: 20, m: 0 };
      } else if (k === 'yesterday') dayMs = base - DAY;
      else dayMs = base + DAY;
    }

    // weekday, optionally "next monday"
    if (dayMs === null) {
      const wd = take(/\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|thurs|thur|saturday|sun|mon|tues|tue|wed|weds|thu|fri(?:day)?|sat)\b/i);
      if (wd) {
        const target = WEEKDAYS[wd[2].toLowerCase()];
        if (target !== undefined) {
          const base = startOfDay(Date.now());
          let delta = (target - new Date(base).getDay() + 7) % 7;
          if (delta === 0) delta = 7; // "monday" on a Monday means the next one
          if (/next/i.test(wd[1] || '') && delta < 7) delta += 0;
          dayMs = base + delta * DAY;
        }
      }
    }

    // "jul 28" / "28 jul" / "7/28" / "7/28/2026"
    if (dayMs === null) {
      const mon = `(${MONTHS.join('|')})[a-z]*`;
      const md = take(new RegExp(`\\b${mon}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'));
      const dm = md ? null : take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}\\.?\\b`, 'i'));
      const slash = md || dm ? null : take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);

      let month = null;
      let dayNum = null;
      let year = now.getFullYear();
      if (md) {
        month = MONTHS.indexOf(md[1].toLowerCase().slice(0, 3));
        dayNum = parseInt(md[2], 10);
      } else if (dm) {
        month = MONTHS.indexOf(dm[2].toLowerCase().slice(0, 3));
        dayNum = parseInt(dm[1], 10);
      } else if (slash) {
        month = parseInt(slash[1], 10) - 1;
        dayNum = parseInt(slash[2], 10);
        if (slash[3]) year = slash[3].length === 2 ? 2000 + parseInt(slash[3], 10) : parseInt(slash[3], 10);
      }
      if (month !== null && month >= 0 && dayNum >= 1 && dayNum <= 31) {
        let d = new Date(year, month, dayNum, 0, 0, 0, 0);
        // A bare day/month that already passed almost always means next year.
        if (!(md && md[3]) && !(slash && slash[3]) && d.getTime() < startOfDay(Date.now())) {
          d = new Date(year + 1, month, dayNum, 0, 0, 0, 0);
        }
        dayMs = d.getTime();
      }
    }
  }

  // time of day
  if (!time) {
    const noon = take(/\b(noon|midday|midnight)\b/i);
    if (noon) time = /midnight/i.test(noon[1]) ? { h: 0, m: 0 } : { h: 12, m: 0 };
  }
  if (!time) {
    const ampm = take(/\b(?:at\s+|@\s*)?(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\b/i);
    if (ampm) {
      let h = parseInt(ampm[1], 10) % 12;
      if (ampm[3].toLowerCase() === 'p') h += 12;
      time = { h, m: ampm[2] ? parseInt(ampm[2], 10) : 0 };
    }
  }
  if (!time) {
    const h24 = take(/\b(?:at\s+|@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (h24) time = { h: parseInt(h24[1], 10), m: parseInt(h24[2], 10) };
  }

  // assemble
  let at = null;
  if (relMs !== null) {
    at = relMs;
  } else if (dayMs !== null || time) {
    const base = new Date(dayMs !== null ? dayMs : startOfDay(Date.now()));
    base.setHours(time ? time.h : 9, time ? time.m : 0, 0, 0);
    // A bare time that already passed today means tomorrow.
    if (dayMs === null && time && base.getTime() < Date.now() - 60_000) {
      base.setTime(base.getTime() + DAY);
    }
    at = base.getTime();
  }

  const title = s
    .replace(/\s+/g, ' ')
    .replace(/\s*[,;]\s*$/, '')
    .replace(/\b(on|at|by|from)\s*$/i, '')
    .trim();

  return { title, at };
}

/* ── persistence ─────────────────────────────────────────────────────── */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.data.save(data), 180);
}

const items = () => data.items;
const find = (id) => data.items.find((i) => i.id === id);
const live = (kind) => data.items.filter((i) => i.kind === kind && !i.archived);

/* ── grouping ────────────────────────────────────────────────────────── */

function groupOf(item, todayStart) {
  if (item.at == null) return { key: 'anytime', label: 'Anytime', order: 9e15, late: false };
  const day = startOfDay(item.at);
  if (item.at < Date.now() && !item.done && day <= todayStart) {
    return { key: 'overdue', label: 'Overdue', order: -1, late: true };
  }
  if (day === todayStart) return { key: 'today', label: 'Today', order: day, late: false };
  if (day === todayStart + DAY) return { key: 'tomorrow', label: 'Tomorrow', order: day, late: false };
  if (day < todayStart) {
    return {
      key: `p${day}`,
      label: new Date(day).toLocaleDateString([], { month: 'short', day: 'numeric' }),
      order: day,
      late: false,
    };
  }
  if (day < todayStart + DAY * 7) {
    return { key: `d${day}`, label: new Date(day).toLocaleDateString([], { weekday: 'long' }), order: day, late: false };
  }
  return {
    key: `d${day}`,
    label: new Date(day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    order: day,
    late: false,
  };
}

function buildGroups(list) {
  const todayStart = startOfDay(Date.now());
  const map = new Map();
  for (const item of list) {
    const g = groupOf(item, todayStart);
    if (!map.has(g.key)) map.set(g.key, { ...g, items: [] });
    map.get(g.key).items.push(item);
  }
  const groups = Array.from(map.values()).sort((a, b) => a.order - b.order);
  for (const g of groups) {
    g.items.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.at != null && b.at != null && a.at !== b.at) return a.at - b.at;
      if (g.key === 'anytime') return b.createdAt - a.createdAt;
      return a.createdAt - b.createdAt;
    });
  }
  return groups;
}

/* ── rendering ───────────────────────────────────────────────────────── */

const ICON = (id, cls = '') => `<svg class="${cls}"><use href="#${id}"/></svg>`;

function nextUpId(list) {
  const upcoming = list
    .filter((i) => !i.done && i.at != null && i.at >= Date.now() - 60_000)
    .sort((a, b) => a.at - b.at);
  return upcoming.length ? upcoming[0].id : null;
}

function itemHtml(item, nextId) {
  const cls = ['item'];
  if (item.done) cls.push('done');
  if (item.id === nextId) cls.push('is-next');
  if (!seenIds.has(item.id)) cls.push('entering');
  seenIds.add(item.id);

  const late = item.at != null && item.at < Date.now() && !item.done;
  const time = item.at != null ? `<span class="time">${esc(fmtTime(item.at))}</span>` : '';
  const meta =
    item.at != null && !item.done
      ? `<div class="meta${late ? ' is-late' : ''}">${esc(relative(item.at))}</div>`
      : '';

  const titleHtml =
    editingId === item.id
      ? `<input class="title-edit" value="${esc(item.title)}" maxlength="240" />`
      : `<span class="title">${esc(item.title)}</span>`;

  return `<article class="${cls.join(' ')}" data-id="${item.id}">
    <button class="check" data-act="toggle" title="Mark complete">${ICON('i-check')}</button>
    <div class="body">
      <div class="row1">${time}${titleHtml}</div>
      ${meta}
    </div>
    <div class="acts">
      <button data-act="edit" title="Rename">${ICON('i-pencil')}</button>
      <button data-act="del" title="Delete">${ICON('i-trash')}</button>
    </div>
  </article>`;
}

function renderList() {
  const kind = view === 'schedule' ? 'event' : 'task';
  const list = live(kind);
  const nextId = nextUpId(list);
  const groups = buildGroups(list);

  el.list.innerHTML = groups
    .map(
      (g) =>
        `<div class="group-label${g.late ? ' is-late' : ''}">${esc(g.label)}</div>` +
        g.items.map((i) => itemHtml(i, nextId)).join('')
    )
    .join('');

  const isEmpty = list.length === 0;
  el.empty.hidden = !isEmpty;
  if (isEmpty) {
    $('.empty-t', el.empty).textContent = view === 'schedule' ? 'No events scheduled' : 'No notes yet';
    $('.empty-s', el.empty).textContent =
      view === 'schedule'
        ? 'Add a meeting below — try “review tomorrow 2pm”.'
        : 'Jot a task below. Completed ones move to the archive.';
  }

  if (editingId) {
    const input = $('.title-edit', el.list);
    if (input) {
      input.focus();
      input.select();
    }
  }
  renderCounts();
}

function renderCounts() {
  const ev = live('event').filter((i) => !i.done).length;
  const tk = live('task').filter((i) => !i.done).length;
  el.cSchedule.textContent = ev;
  el.cNotes.textContent = tk;
  el.cSchedule.classList.toggle('is-zero', ev === 0);
  el.cNotes.classList.toggle('is-zero', tk === 0);

  // Tab badge counts what actually needs attention today.
  const soon = startOfDay(Date.now()) + DAY;
  const due = items().filter((i) => !i.archived && !i.done && i.at != null && i.at < soon).length;
  el.tabBadge.hidden = due === 0;
  el.tabBadge.textContent = due > 99 ? '99+' : String(due);
  el.tabDot.classList.toggle('is-idle', ev + tk === 0);
}

function renderHeader() {
  const now = new Date();
  el.weekday.textContent = now.toLocaleDateString([], { weekday: 'long' });
  el.date.textContent = now.toLocaleDateString([], { day: 'numeric', month: 'short' });

  const upcoming = items()
    .filter((i) => !i.archived && !i.done && i.at != null && i.at >= Date.now() - 60_000)
    .sort((a, b) => a.at - b.at)[0];
  const overdue = items().filter((i) => !i.archived && !i.done && i.at != null && i.at < Date.now()).length;

  if (overdue) el.sub.textContent = `${overdue} overdue`;
  else if (upcoming) el.sub.textContent = `Next · ${upcoming.title} ${relative(upcoming.at)}`;
  else el.sub.textContent = 'Nothing scheduled';
}

function renderArchive() {
  const list = items()
    .filter((i) => i.archived)
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));

  if (!list.length) {
    el.archiveList.innerHTML = `<div class="empty">${ICON('i-archive')}
      <p class="empty-t">Archive is empty</p>
      <p class="empty-s">Completed events and notes land here.</p></div>`;
    return;
  }

  el.archiveList.innerHTML = list
    .map(
      (i) => `<div class="arc-item" data-id="${i.id}">
      <span class="arc-kind">${ICON(i.kind === 'event' ? 'i-calendar' : 'i-check')}</span>
      <div class="body">
        <div class="row1"><span class="title">${esc(i.title)}</span></div>
        <div class="meta">${esc(i.at != null ? fmtTime(i.at) + ' · ' : '')}${esc(
        new Date(i.archivedAt || i.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })
      )}</div>
      </div>
      <div class="acts" style="opacity:1;transform:none">
        <button data-act="restore" title="Restore">${ICON('i-undo')}</button>
        <button data-act="purge" title="Delete forever">${ICON('i-trash')}</button>
      </div>
    </div>`
    )
    .join('');
}

function renderAll() {
  renderHeader();
  renderList();
  if (!el.sheet.hidden) renderArchive();
}

/* ── mutations ───────────────────────────────────────────────────────── */

function addItem(title, at) {
  const item = {
    id: uid(),
    kind: view === 'schedule' ? 'event' : 'task',
    title,
    at: at ?? null,
    done: false,
    doneAt: null,
    archived: false,
    archivedAt: null,
    createdAt: Date.now(),
    notified: at != null && at < Date.now(),
  };
  data.items.push(item);
  save();
  renderAll();
  el.scroller.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Completing is a two-beat interaction: strike through in place so the user
 * sees what they just did, then retire the item to archive (or delete).
 */
function complete(id) {
  const item = find(id);
  if (!item) return;

  if (pending.has(id)) return uncomplete(id); // clicked again during the dwell

  item.done = true;
  item.doneAt = Date.now();
  save();

  const node = el.list.querySelector(`[data-id="${id}"]`);
  if (node) {
    node.classList.add('done');
  }
  renderCounts();
  renderHeader();

  const timer = setTimeout(() => {
    pending.delete(id);
    const node2 = el.list.querySelector(`[data-id="${id}"]`);
    const retire = () => {
      const it = find(id);
      if (!it) return;
      if (settings.onComplete === 'delete') {
        data.items = data.items.filter((x) => x.id !== id);
      } else {
        it.archived = true;
        it.archivedAt = Date.now();
      }
      save();
      renderAll();
    };
    if (node2) {
      node2.classList.add('leaving');
      setTimeout(retire, 280);
    } else {
      retire();
    }
  }, COMPLETE_DELAY);

  pending.set(id, { timer });

  const verb = settings.onComplete === 'delete' ? 'Deleted' : 'Archived';
  showToast(`${verb} · ${item.title}`, () => uncomplete(id));
}

function uncomplete(id) {
  const p = pending.get(id);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(id);
  }
  const item = find(id);
  if (item) {
    item.done = false;
    item.doneAt = null;
    item.archived = false;
    item.archivedAt = null;
    save();
  }
  hideToast();
  renderAll();
}

function removeItem(id) {
  const item = find(id);
  if (!item) return;
  const snapshot = { ...item };
  data.items = data.items.filter((x) => x.id !== id);
  save();

  const node = el.list.querySelector(`[data-id="${id}"]`);
  const done = () => {
    renderAll();
    showToast(`Deleted · ${snapshot.title}`, () => {
      data.items.push(snapshot);
      save();
      renderAll();
    });
  };
  if (node) {
    node.classList.add('leaving');
    setTimeout(done, 280);
  } else done();
}

/* ── toast ───────────────────────────────────────────────────────────── */

function showToast(text, onUndo) {
  clearTimeout(toastTimer);
  undoAction = onUndo;
  el.toastText.textContent = text;
  el.toast.hidden = false;
  el.toast.classList.remove('is-out');
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  clearTimeout(toastTimer);
  if (el.toast.hidden) return;
  el.toast.classList.add('is-out');
  setTimeout(() => {
    el.toast.hidden = true;
    el.toast.classList.remove('is-out');
    undoAction = null;
  }, 200);
}

el.toastUndo.addEventListener('click', () => {
  const fn = undoAction;
  hideToast();
  if (fn) fn();
});

/* ── composer ────────────────────────────────────────────────────────── */

function currentWhen() {
  if (manualWhen) return manualWhen.at;
  return parseWhen(el.input.value).at;
}

function refreshComposer() {
  const text = el.input.value.trim();
  el.form.classList.toggle('has-text', text.length > 0);

  const at = currentWhen();
  if (at == null) {
    el.parsed.hidden = true;
  } else {
    el.parsed.hidden = false;
    const d = new Date(at);
    const dayStart = startOfDay(at);
    const today = startOfDay(Date.now());
    let dayLabel;
    if (dayStart === today) dayLabel = 'Today';
    else if (dayStart === today + DAY) dayLabel = 'Tomorrow';
    else if (dayStart === today - DAY) dayLabel = 'Yesterday';
    else dayLabel = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    $('span', el.chipWhen).textContent = `${dayLabel} · ${fmtTime(at)}`;
  }
  $('[data-act="when"]').classList.toggle('is-on', at != null);
}

el.input.addEventListener('input', refreshComposer);

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = el.input.value.trim();
  if (!raw) return;

  const parsed = parseWhen(raw);
  let title;
  let at;
  if (manualWhen) {
    at = manualWhen.at;
    title = at == null ? raw : parsed.title || raw;
  } else {
    at = parsed.at;
    title = parsed.title || raw;
  }
  if (!title) title = raw;

  addItem(title, at);
  el.input.value = '';
  manualWhen = null;
  refreshComposer();
  el.input.focus();
});

$('#chipClear').addEventListener('click', () => {
  manualWhen = { at: null };
  refreshComposer();
  el.input.focus();
});
el.chipWhen.addEventListener('click', () => openWhen());

/* ── when popover ────────────────────────────────────────────────────── */

function openWhen() {
  const at = currentWhen();
  el.popInput.value = toLocalInput(at ?? Date.now() + 3_600_000);
  el.pop.hidden = false;
  el.popInput.focus();
}
function closeWhen() {
  el.pop.hidden = true;
}

function quickWhen(kind) {
  const d = new Date();
  switch (kind) {
    case '1h':
      d.setTime(Date.now() + 3_600_000);
      d.setSeconds(0, 0);
      break;
    case 'today18':
      d.setHours(18, 0, 0, 0);
      break;
    case 'tom9':
      d.setTime(startOfDay(Date.now()) + DAY);
      d.setHours(9, 0, 0, 0);
      break;
    case 'mon9': {
      const base = startOfDay(Date.now());
      let delta = (1 - new Date(base).getDay() + 7) % 7 || 7;
      d.setTime(base + delta * DAY);
      d.setHours(9, 0, 0, 0);
      break;
    }
  }
  manualWhen = { at: d.getTime() };
  closeWhen();
  refreshComposer();
  el.input.focus();
}

el.pop.addEventListener('click', (e) => {
  const q = e.target.closest('[data-quick]');
  if (q) return quickWhen(q.dataset.quick);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'whenClose') closeWhen();
  if (act === 'whenNone') {
    manualWhen = { at: null };
    closeWhen();
    refreshComposer();
  }
  if (act === 'whenSet') {
    const v = el.popInput.value;
    manualWhen = { at: v ? new Date(v).getTime() : null };
    closeWhen();
    refreshComposer();
    el.input.focus();
  }
});

/* ── list interactions ───────────────────────────────────────────────── */

el.list.addEventListener('click', (e) => {
  const node = e.target.closest('.item');
  if (!node) return;
  const id = node.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;

  if (act === 'toggle') complete(id);
  else if (act === 'del') removeItem(id);
  else if (act === 'edit') {
    editingId = id;
    renderList();
  }
});

el.list.addEventListener('dblclick', (e) => {
  const node = e.target.closest('.item');
  if (!node || e.target.closest('button')) return;
  editingId = node.dataset.id;
  renderList();
});

function commitEdit(input, keep) {
  const node = input.closest('.item');
  const item = find(node?.dataset.id);
  if (item && keep) {
    const v = input.value.trim();
    if (v) item.title = v;
    save();
  }
  editingId = null;
  renderAll();
}

el.list.addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('title-edit')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    commitEdit(e.target, true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    commitEdit(e.target, false);
  }
});
el.list.addEventListener(
  'focusout',
  (e) => {
    if (e.target.classList.contains('title-edit') && editingId) commitEdit(e.target, true);
  },
  true
);

/* ── views ───────────────────────────────────────────────────────────── */

function setView(next) {
  if (next === view) return;
  view = next;
  el.html.dataset.view = view;
  $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));
  el.input.placeholder = view === 'schedule' ? 'Add an event…' : 'Add a note or task…';
  el.hint.textContent =
    view === 'schedule' ? 'Try “standup tomorrow 9:30am”' : 'Try “email Ana friday” — time is optional';
  api.settings.set({ view });
  renderList();
}

el.seg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) setView(btn.dataset.view);
});

/* ── sheet ───────────────────────────────────────────────────────────── */

function openSheet(pane = 'archive') {
  el.sheet.hidden = false;
  el.sheet.classList.remove('is-out');
  setPane(pane);
  renderArchive();
  syncSettingsUi();
}
function closeSheet() {
  el.sheet.classList.add('is-out');
  setTimeout(() => {
    el.sheet.hidden = true;
    el.sheet.classList.remove('is-out');
  }, 180);
}
function setPane(pane) {
  $$('.sheet-seg button').forEach((b) => b.classList.toggle('is-on', b.dataset.sheet === pane));
  $$('[data-pane]').forEach((s) => (s.hidden = s.dataset.pane !== pane));
}

el.sheet.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-sheet]');
  if (seg) return setPane(seg.dataset.sheet);

  const arc = e.target.closest('.arc-item');
  const act = e.target.closest('[data-act]')?.dataset.act;

  if (arc && act === 'restore') {
    const item = find(arc.dataset.id);
    if (item) {
      item.archived = false;
      item.archivedAt = null;
      item.done = false;
      item.doneAt = null;
      save();
      renderAll();
      renderArchive();
    }
    return;
  }
  if (arc && act === 'purge') {
    data.items = data.items.filter((x) => x.id !== arc.dataset.id);
    save();
    renderArchive();
    return;
  }

  if (act === 'sheetClose') closeSheet();
  if (act === 'clearArchive') {
    data.items = data.items.filter((x) => !x.archived);
    save();
    renderArchive();
  }
  if (act === 'screen') api.dock.cycleDisplay();
  if (act === 'quit') api.quit();

  const pick = e.target.closest('.pick button');
  if (pick) {
    const key = pick.parentElement.dataset.pick;
    applySettings({ [key]: pick.dataset.value });
  }
});

el.sheet.addEventListener('change', (e) => {
  const key = e.target.dataset?.toggle;
  if (key) applySettings({ [key]: e.target.checked });
});

/* ── settings ────────────────────────────────────────────────────────── */

async function applySettings(patch) {
  settings = await api.settings.set(patch);
  syncSettingsUi();
  if ('onComplete' in patch) renderAll();
}

function syncSettingsUi() {
  $$('.pick').forEach((p) => {
    const val = settings[p.dataset.pick];
    $$('button', p).forEach((b) => b.classList.toggle('is-on', b.dataset.value === val));
  });
  $$('[data-toggle]').forEach((t) => {
    t.checked = !!settings[t.dataset.toggle];
  });
}

/* ── theme ───────────────────────────────────────────────────────────── */

api.theme.onChange(({ resolved }) => {
  el.html.dataset.theme = resolved;
});

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(settings.theme || 'system') + 1) % order.length];
  applySettings({ theme: next });
}

/* ── embedded AI browser ─────────────────────────────────────────────── */

const AI_PARTITION = 'persist:sidenote-ai';
const aiViews = new Map(); // key -> <webview>
let aiSites = {};
let aiTab = 'chatgpt';

const aiOpen = () => !el.ai.hidden;

function showAiState(text, isError = false) {
  el.aiStateText.textContent = text;
  el.aiState.classList.toggle('is-error', isError);
  el.aiState.hidden = false;
}
const hideAiState = () => {
  el.aiState.hidden = true;
};

/** Webviews are created on first use so no chat site loads at startup. */
function ensureAiView(key) {
  if (aiViews.has(key)) return aiViews.get(key);
  const site = aiSites[key];
  if (!site) return null;

  const view = document.createElement('webview');
  view.setAttribute('partition', AI_PARTITION);
  view.setAttribute('allowpopups', ''); // sign-in flows open popups
  view.setAttribute('src', site.url);
  view.hidden = true;

  view.addEventListener('did-start-loading', () => {
    if (aiTab === key) showAiState(`Loading ${site.label}…`);
  });
  view.addEventListener('did-stop-loading', () => {
    if (aiTab === key) hideAiState();
  });
  view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // aborted — almost always a redirect
    if (aiTab === key) showAiState(`Couldn't reach ${site.label}. Check your connection.`, true);
  });

  // Google refuses OAuth in embedded browsers, so say so the moment we land
  // there rather than letting the user hit an opaque "browser may not be
  // secure" wall.
  const checkGoogle = () => {
    if (aiTab !== key) return;
    let host = '';
    try {
      host = new URL(view.getURL()).hostname;
    } catch (_) {
      return;
    }
    if (host.endsWith('accounts.google.com')) el.aiNote.hidden = false;
  };
  view.addEventListener('did-navigate', checkGoogle);
  view.addEventListener('did-navigate-in-page', checkGoogle);

  el.aiBody.appendChild(view);
  aiViews.set(key, view);
  return view;
}

function setAiTab(key) {
  if (!aiSites[key]) return;
  aiTab = key;
  el.aiSeg.dataset.on = key;
  $$('button', el.aiSeg).forEach((b) => b.classList.toggle('is-on', b.dataset.ai === key));

  hideAiState();
  el.aiNote.hidden = true;
  const view = ensureAiView(key);
  aiViews.forEach((v, k) => {
    v.hidden = k !== key;
  });
  if (view && typeof view.isLoading === 'function' && view.isLoading()) {
    showAiState(`Loading ${aiSites[key].label}…`);
  }
  api.ai.setTab(key);
}

function openAiPane() {
  if (!el.pop.hidden) closeWhen();
  if (!el.sheet.hidden) closeSheet();
  el.ai.hidden = false;
  el.html.classList.add('ai-mode');
  $('[data-act="ai"]').classList.add('is-on');
  setAiTab(aiTab);
  api.ai.setOpen(true);
}

function closeAiPane() {
  el.ai.hidden = true;
  el.html.classList.remove('ai-mode');
  $('[data-act="ai"]').classList.remove('is-on');
  api.ai.setOpen(false);
}

const toggleAiPane = () => (aiOpen() ? closeAiPane() : openAiPane());

el.ai.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-ai]');
  if (tab) return setAiTab(tab.dataset.ai);

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'aiClose') closeAiPane();
  if (act === 'aiNoteClose') el.aiNote.hidden = true;
  if (act === 'aiPopout') api.ai.popOut(aiTab);
  if (act === 'aiBack') {
    // Get off Google's rejection page and back to the site's own sign-in form,
    // where an email address can be used instead.
    const view = aiViews.get(aiTab);
    if (view) {
      el.aiNote.hidden = true;
      if (typeof view.canGoBack === 'function' && view.canGoBack()) view.goBack();
      else view.loadURL(aiSites[aiTab].url);
    }
  }
  if (act === 'aiReload') {
    const view = aiViews.get(aiTab);
    if (view) {
      hideAiState();
      el.aiNote.hidden = true;
      view.reload();
    }
  }
});

/* ── header actions ──────────────────────────────────────────────────── */

$('.head-actions').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'collapse') api.dock.collapse();
  else if (act === 'theme') cycleTheme();
  else if (act === 'ai') toggleAiPane();
  else if (act === 'menu') (el.sheet.hidden ? openSheet('archive') : closeSheet());
  else if (act === 'screen') api.dock.cycleDisplay();
});

$('[data-act="when"]').addEventListener('click', () => (el.pop.hidden ? openWhen() : closeWhen()));

/* ── dock state + dragging ───────────────────────────────────────────── */

let wasCollapsed = true;

function applyDock(m) {
  el.html.classList.toggle('collapsed', m.collapsed);
  el.html.classList.toggle('edge-left', m.edge === 'left');
  el.html.classList.toggle('edge-right', m.edge !== 'left');
  el.html.style.setProperty('--panel-w', `${m.panelW}px`);
  el.html.style.setProperty('--panel-h', `${m.panelH}px`);
  el.html.style.setProperty('--tab-w', `${m.tabW}px`);
  el.html.style.setProperty('--tab-h', `${m.tabH}px`);
  if (el.screenInfo) {
    el.screenInfo.textContent = `${m.displayCount} display${m.displayCount === 1 ? '' : 's'} detected`;
  }
  // Focus the composer only when the panel actually opens — a re-layout from a
  // monitor being plugged in shouldn't steal the caret.
  if (wasCollapsed && !m.collapsed && el.ai.hidden) setTimeout(() => el.input.focus(), 120);
  wasCollapsed = m.collapsed;
}

api.dock.onState(applyDock);

/**
 * Drag-to-move. A short press without movement is a click (toggle); once the
 * pointer travels past the threshold we hand tracking to the main process,
 * which follows the OS cursor and can therefore snap across monitors.
 */
function makeDraggable(node, onClick) {
  let origin = null;
  let dragging = false;

  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    origin = { x: e.screenX, y: e.screenY };
    dragging = false;
    node.setPointerCapture(e.pointerId);
  });

  node.addEventListener('pointermove', (e) => {
    if (!origin || dragging) return;
    if (Math.abs(e.screenX - origin.x) + Math.abs(e.screenY - origin.y) > 4) {
      dragging = true;
      api.dock.dragStart();
    }
  });

  const end = (e) => {
    if (!origin) return;
    if (node.hasPointerCapture?.(e.pointerId)) node.releasePointerCapture(e.pointerId);
    if (dragging) api.dock.dragEnd();
    else if (onClick) onClick();
    origin = null;
    dragging = false;
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

makeDraggable(el.grip, null);
makeDraggable(el.tab, () => api.dock.expand());

/* ── keyboard ────────────────────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.pop.hidden) return closeWhen();
    if (!el.sheet.hidden) return closeSheet();
    if (aiOpen()) return closeAiPane();
    if (editingId) return;
    return api.dock.collapse();
  }
  if (e.ctrlKey && (e.key === '1' || e.key === '2')) {
    e.preventDefault();
    setView(e.key === '1' ? 'schedule' : 'notes');
  }
  if (e.key === '/' && document.activeElement !== el.input && !editingId) {
    e.preventDefault();
    el.input.focus();
  }
});

document.addEventListener('pointerdown', (e) => {
  if (!el.pop.hidden && !el.pop.contains(e.target) && !e.target.closest('[data-act="when"], #chipWhen')) {
    closeWhen();
  }
});

/* ── reminders + ticking ─────────────────────────────────────────────── */

let lastDay = startOfDay(Date.now());

setInterval(() => {
  const now = Date.now();

  if (settings.reminders) {
    for (const item of items()) {
      if (item.archived || item.done || item.notified || item.at == null) continue;
      if (item.at <= now && now - item.at < 10 * 60_000) {
        item.notified = true;
        api.notify({
          title: item.kind === 'event' ? 'Starting now' : 'Due now',
          body: item.title,
        });
        save();
      }
    }
  }

  const today = startOfDay(now);
  if (today !== lastDay) {
    lastDay = today;
    renderAll();
    return;
  }
  // Relative times drift; refresh unless an item is mid-animation.
  if (pending.size === 0 && !editingId) {
    renderHeader();
    renderList();
  }
}, 20_000);

/* ── boot ────────────────────────────────────────────────────────────── */

(async function boot() {
  const [loaded, s, metrics, sites] = await Promise.all([
    api.data.load(),
    api.settings.get(),
    api.dock.metrics(),
    api.ai.sites(),
  ]);

  aiSites = sites || {};
  if (aiSites[s.aiTab]) aiTab = s.aiTab;

  data = loaded && Array.isArray(loaded.items) ? loaded : { version: 1, items: [] };
  // Legacy shape from an earlier build.
  if (Array.isArray(loaded?.events) || Array.isArray(loaded?.tasks)) {
    data.items = [
      ...(loaded.events || []).map((i) => ({ ...i, kind: 'event' })),
      ...(loaded.tasks || []).map((i) => ({ ...i, kind: 'task' })),
    ];
  }
  data.items.forEach((i) => seenIds.add(i.id));

  settings = s;
  view = s.view === 'notes' ? 'notes' : 'schedule';
  el.html.dataset.view = view;
  $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));
  el.input.placeholder = view === 'schedule' ? 'Add an event…' : 'Add a note or task…';

  applyDock(metrics);
  syncSettingsUi();
  renderAll();
  refreshComposer();

  document.fonts.ready.then(() => {
    if (!document.fonts.check('500 12px Manrope')) {
      console.warn('Manrope did not load — falling back to the system UI font.');
    } else {
      console.log('font ok: Manrope');
    }
  });

  api.settings.onChange((next) => {
    settings = next;
    syncSettingsUi();
  });
})();
