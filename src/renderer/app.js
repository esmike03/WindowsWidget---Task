'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Sidenote renderer
   Item = { id, kind:'event'|'task', title, at:number|null, done, doneAt,
            archived, archivedAt, createdAt, notified }
   Link = { id, url, title, category:string, createdAt }
   ═══════════════════════════════════════════════════════════════════════ */

const api = window.sidenote;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const el = {
  html: document.documentElement,
  tab: $('#tab'),
  tabBadge: $('#tabBadge'),
  panel: $('#panel'),
  grip: $('#grip'),
  weekday: $('#hWeekday'),
  date: $('#hDate'),
  sub: $('#hSub'),
  seg: $('#seg'),
  cSchedule: $('#cSchedule'),
  cNotes: $('#cNotes'),
  cLinks: $('#cLinks'),
  scroller: $('#scroller'),
  list: $('#list'),
  empty: $('#empty'),
  form: $('#form'),
  input: $('#input'),
  parsed: $('#parsed'),
  chipWhen: $('#chipWhen'),
  chipCat: $('#chipCat'),
  hint: $('#hint'),
  pop: $('#when'),
  popInput: $('#whenInput'),
  catPop: $('#cat'),
  catList: $('#catList'),
  catInput: $('#catInput'),
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
  aiNoteTitle: $('#aiNoteTitle'),
  aiNoteBody: $('#aiNoteBody'),
  aiNoteCta: $('#aiNoteCta'),
  aiToolbar: $('#aiToolbar'),
  aiToolName: $('#aiToolName'),
  toolList: $('#toolList'),
  toolSearch: $('#toolSearch'),
  toolAdd: $('#toolAdd'),
  toolAddButton: $('#toolAddButton'),
  toolAddName: $('#toolAddName'),
  toolAddUrl: $('#toolAddUrl'),
  toolAddCat: $('#toolAddCat'),
  toolAddMsg: $('#toolAddMsg'),
  toolAddCancel: $('#toolAddCancel'),
  toolAddSave: $('#toolAddSave'),
  slotLabel: $('#slotLabel'),
  slotUrl: $('#slotUrl'),
  slotMsg: $('#slotMsg'),
  mailPick: $('#mailPick'),
};

let data = { version: 1, items: [], links: [] };
let settings = {};
let view = 'schedule';
let manualWhen = null; // { at: number|null } — overrides text parsing until submit
let manualCat = null; // string | '' (unsorted) | null — same idea for link categories
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

/* ── link parsing ────────────────────────────────────────────────────── */

const UNSORTED = 'Unsorted';

// An explicit scheme is taken at face value (that's how "localhost:3000" gets
// through); otherwise a token needs a dot and a real-looking TLD, so "v1.2"
// and "at 3.30" aren't mistaken for links.
const URL_RE =
  /(?:^|\s)(https?:\/\/[^\s]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:[/?#][^\s]*)?)(?=\s|$)/i;
const TAG_RE = /(?:^|\s)#([\w-]{1,24})(?=\s|$)/;

/** Tidies a category label: "#to-do " → "To Do". */
function normalizeCat(raw) {
  const s = String(raw || '')
    .replace(/^#/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  if (!s || s.toLowerCase() === UNSORTED.toLowerCase()) return '';
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/**
 * Reuses the spelling of an existing category when one matches case-insensitively,
 * so "reading" and "READING" don't end up as two separate groups.
 */
function canonicalCat(raw) {
  const s = normalizeCat(raw);
  if (!s) return '';
  const hit = categories().find((c) => c.toLowerCase() === s.toLowerCase());
  return hit || s;
}

function toUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch (_) {
    return null;
  }
}

const hostOf = (u) => u.hostname.replace(/^www\./i, '');

/** "https://www.figma.com/file/x" → "Figma" */
function defaultTitle(u) {
  const label = hostOf(u).split('.')[0] || hostOf(u);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function linkMeta(url) {
  const u = toUrl(url);
  if (!u) return url;
  const rest = `${u.pathname}${u.search}`.replace(/\/$/, '');
  const tail = rest.length > 30 ? `${rest.slice(0, 29)}…` : rest;
  return hostOf(u) + tail;
}

/** Stable per-host hue so the same site always gets the same coloured chip. */
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

/** Lifts a `#category` out of text, returning it plus the remaining words. */
function takeTag(raw) {
  const s = ` ${raw} `;
  const tag = s.match(TAG_RE);
  const rest = tag ? `${s.slice(0, tag.index)} ${s.slice(tag.index + tag[0].length)}` : s;
  return {
    category: tag ? normalizeCat(tag[1]) : null,
    rest: rest.replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Pulls a URL and an optional `#category` out of free text; whatever is left
 * becomes the title.
 */
function parseLink(raw) {
  const tagged = takeTag(raw);
  const category = tagged.category;
  let s = ` ${tagged.rest} `;

  const m = s.match(URL_RE);
  let url = null;
  if (m) {
    const u = toUrl(m[1]);
    if (u) {
      url = u.href;
      s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    }
  }

  const title = s.replace(/\s+/g, ' ').replace(/^[-–—:|,]+|[-–—:|,]+$/g, '').trim();
  return { url, title, category };
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

const links = () => data.links;
const findLink = (id) => data.links.find((l) => l.id === id);

/** Every category currently in use, alphabetical. */
function categories() {
  const set = new Set();
  for (const l of links()) if (l.category) set.add(l.category);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

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

function linkHtml(link) {
  const cls = ['item', 'is-link'];
  if (!seenIds.has(link.id)) cls.push('entering');
  seenIds.add(link.id);

  const u = toUrl(link.url);
  const host = u ? hostOf(u) : link.url;
  // Letter and tint both come from the host, so the chip reads as a site badge
  // the way a favicon would — renaming the link doesn't change it.
  const letter = host.replace(/^\W+/, '').charAt(0).toUpperCase() || '?';

  const titleHtml =
    editingId === link.id
      ? `<input class="title-edit" value="${esc(link.title)}" maxlength="240" />`
      : `<span class="title">${esc(link.title)}</span>`;

  // The hue rides on a data attribute, not an inline style: our CSP is
  // `style-src 'self'`, which blocks style="" attributes outright.
  return `<article class="${cls.join(' ')}" data-id="${link.id}" title="${esc(link.url)}">
    <span class="fav" data-hue="${hueOf(host)}" aria-hidden="true">${esc(letter)}</span>
    <div class="body">
      <div class="row1">${titleHtml}</div>
      <div class="meta">${esc(linkMeta(link.url))}</div>
    </div>
    <div class="acts">
      <button data-act="edit" title="Rename">${ICON('i-pencil')}</button>
      <button data-act="del" title="Delete">${ICON('i-trash')}</button>
    </div>
  </article>`;
}

function renderLinks() {
  const all = links();
  const map = new Map();
  for (const l of all) {
    const key = l.category || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(l);
  }

  // Named categories alphabetically; anything unfiled sits at the bottom.
  const groups = Array.from(map.entries()).sort(([a], [b]) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  el.list.innerHTML = groups
    .map(([cat, rows]) => {
      rows.sort((x, y) => y.createdAt - x.createdAt);
      return (
        `<div class="group-label">${esc(cat || UNSORTED)}</div>` + rows.map(linkHtml).join('')
      );
    })
    .join('');

  // setProperty from script is allowed where a style attribute is not.
  $$('.fav', el.list).forEach((n) => n.style.setProperty('--fav-h', n.dataset.hue));

  el.empty.hidden = all.length > 0;
  if (!all.length) {
    $('.empty-t', el.empty).textContent = 'No links saved';
    $('.empty-s', el.empty).textContent = 'Paste a URL below — add #design to file it under a category.';
    $('.empty svg use', el.empty)?.setAttribute('href', '#i-link');
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

function renderList() {
  if (view === 'links') return renderLinks();
  $('.empty svg use', el.empty)?.setAttribute('href', '#i-inbox');

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
  const lk = links().length;
  el.cSchedule.textContent = ev;
  el.cNotes.textContent = tk;
  el.cLinks.textContent = lk;
  el.cSchedule.classList.toggle('is-zero', ev === 0);
  el.cNotes.classList.toggle('is-zero', tk === 0);
  el.cLinks.classList.toggle('is-zero', lk === 0);

  // Tab badge counts what actually needs attention today.
  const soon = startOfDay(Date.now()) + DAY;
  const due = items().filter((i) => !i.archived && !i.done && i.at != null && i.at < soon).length;
  el.tabBadge.hidden = due === 0;
  el.tabBadge.textContent = due > 99 ? '99+' : String(due);
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

function addLink(url, title, category) {
  const u = toUrl(url);
  if (!u) return false;
  const link = {
    id: uid(),
    url: u.href,
    title: title || defaultTitle(u),
    category: canonicalCat(category),
    createdAt: Date.now(),
  };
  data.links.push(link);
  save();
  renderAll();
  el.scroller.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

function removeLink(id) {
  const link = findLink(id);
  if (!link) return;
  const snapshot = { ...link };
  data.links = data.links.filter((l) => l.id !== id);
  save();

  const node = el.list.querySelector(`[data-id="${id}"]`);
  const done = () => {
    renderAll();
    showToast(`Deleted · ${snapshot.title}`, () => {
      data.links.push(snapshot);
      save();
      renderAll();
    });
  };
  if (node) {
    node.classList.add('leaving');
    setTimeout(done, 280);
  } else done();
}

function openLink(id) {
  const link = findLink(id);
  if (link) api.links.open(link.url);
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
  undoAction = onUndo || null;
  el.toastText.textContent = text;
  el.toastUndo.hidden = !undoAction;
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

function currentCat() {
  if (manualCat !== null) return manualCat;
  return parseLink(el.input.value).category ?? '';
}

function refreshComposer() {
  const text = el.input.value.trim();
  el.form.classList.toggle('has-text', text.length > 0);

  if (view === 'links') {
    const cat = currentCat();
    el.chipWhen.hidden = true;
    el.chipCat.hidden = !cat;
    el.parsed.hidden = !cat;
    if (cat) $('span', el.chipCat).textContent = cat;
    $('[data-act="cat"]').classList.toggle('is-on', !!cat);
    return;
  }

  el.chipCat.hidden = true;
  el.chipWhen.hidden = false;
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

  if (view === 'links') {
    const parsed = parseLink(raw);
    if (!parsed.url) {
      // Nothing usable — say so rather than silently swallowing the input.
      el.form.classList.add('is-bad');
      setTimeout(() => el.form.classList.remove('is-bad'), 500);
      showToast('That doesn’t look like a link', null);
      return;
    }
    addLink(parsed.url, parsed.title, manualCat !== null ? manualCat : parsed.category);
    el.input.value = '';
    manualCat = null;
    refreshComposer();
    el.input.focus();
    return;
  }

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
  if (view === 'links') manualCat = '';
  else manualWhen = { at: null };
  refreshComposer();
  el.input.focus();
});
el.chipWhen.addEventListener('click', () => openWhen());
el.chipCat.addEventListener('click', () => openCat());

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

/* ── category popover ────────────────────────────────────────────────── */

function renderCatList() {
  const current = currentCat();
  el.catList.innerHTML = categories()
    .map(
      (c) =>
        `<button type="button" data-cat="${esc(c)}"${c === current ? ' class="is-on"' : ''}>${esc(c)}</button>`
    )
    .join('');
}

function openCat() {
  renderCatList();
  el.catInput.value = '';
  el.catPop.hidden = false;
  el.catInput.focus();
}
function closeCat() {
  el.catPop.hidden = true;
}

function pickCat(value) {
  manualCat = canonicalCat(value);
  closeCat();
  refreshComposer();
  el.input.focus();
}

el.catPop.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-cat]');
  if (chip) return pickCat(chip.dataset.cat);

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'catClose') closeCat();
  if (act === 'catNone') pickCat('');
  if (act === 'catSet') pickCat(el.catInput.value);
});

el.catInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    pickCat(el.catInput.value);
  }
});

/* ── list interactions ───────────────────────────────────────────────── */

el.list.addEventListener('click', (e) => {
  const node = e.target.closest('.item');
  if (!node) return;
  const id = node.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;

  if (node.classList.contains('is-link')) {
    if (act === 'del') removeLink(id);
    else if (act === 'edit') {
      editingId = id;
      renderList();
    } else if (!e.target.closest('.title-edit')) {
      openLink(id); // anywhere else on the row opens it in the real browser
    }
    return;
  }

  if (act === 'toggle') complete(id);
  else if (act === 'del') removeItem(id);
  else if (act === 'edit') {
    editingId = id;
    renderList();
  }
});

el.list.addEventListener('dblclick', (e) => {
  const node = e.target.closest('.item');
  // A single click already opens a link, so double-click must not also edit it.
  if (!node || node.classList.contains('is-link') || e.target.closest('button')) return;
  editingId = node.dataset.id;
  renderList();
});

function commitEdit(input, keep) {
  const node = input.closest('.item');
  const id = node?.dataset.id;

  if (node?.classList.contains('is-link')) {
    const link = findLink(id);
    if (link && keep) {
      // Typing "#work" while renaming re-files the link.
      const { category, rest } = takeTag(input.value);
      if (category !== null) link.category = canonicalCat(category);
      if (rest) link.title = rest;
      save();
    }
    editingId = null;
    renderAll();
    return;
  }

  const item = find(id);
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

const PLACEHOLDER = {
  schedule: 'Add an event…',
  notes: 'Add a note or task…',
  links: 'Paste a link…',
};
const HINT = {
  schedule: 'Try “standup tomorrow 9:30am”',
  notes: 'Try “email Ana friday” — time is optional',
  links: 'Try “figma.com/file/x moodboard #design”',
};

function applyViewChrome() {
  el.html.dataset.view = view;
  $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));
  el.input.placeholder = PLACEHOLDER[view];
  el.hint.textContent = HINT[view];
  $('[data-act="when"]').hidden = view === 'links';
  $('[data-act="cat"]').hidden = view !== 'links';
}

function setView(next) {
  if (next === view) return;
  view = next;
  closeWhen();
  closeCat();
  manualWhen = null;
  manualCat = null;
  applyViewChrome();
  api.settings.set({ view });
  renderList();
  refreshComposer();
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
  $('[data-act="tools"]').classList.remove('is-on');
  el.sheet.classList.add('is-out');
  setTimeout(() => {
    el.sheet.hidden = true;
    el.sheet.classList.remove('is-out');
  }, 180);
}
function setPane(pane) {
  $$('.sheet-seg button').forEach((b) => b.classList.toggle('is-on', b.dataset.sheet === pane));
  $$('[data-pane]').forEach((s) => (s.hidden = s.dataset.pane !== pane));
  $('[data-act="tools"]').classList.toggle('is-on', pane === 'tools');
  if (pane === 'tools') {
    loadTools();
    setTimeout(() => el.toolSearch.focus(), 60);
  }
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

  const mail = e.target.closest('[data-mail]');
  if (mail) {
    api.ai.setMail(mail.dataset.mail).then((res) => {
      if (res?.ok) applyPaneSites(res.sites, 'mail');
    });
    return;
  }

  if (act === 'slotSave') {
    el.slotMsg.textContent = '';
    el.slotMsg.classList.remove('is-bad');
    api.ai.setCustom({ label: el.slotLabel.value, url: el.slotUrl.value }).then((res) => {
      if (res?.ok) {
        applyPaneSites(res.sites, 'custom');
        el.slotMsg.textContent = 'Saved';
        setTimeout(() => {
          el.slotMsg.textContent = '';
        }, 1600);
      } else {
        el.slotMsg.textContent = res?.error || 'Could not save that';
        el.slotMsg.classList.add('is-bad');
      }
    });
    return;
  }

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

/**
 * A slot's site changed: relabel the strip and drop the old webview so the
 * next visit loads the new address rather than the previous tenant.
 */
function applyPaneSites(sites, changedKey) {
  aiSites = sites || aiSites;
  renderAiTabs();
  const view = aiViews.get(changedKey);
  if (view) {
    view.remove();
    aiViews.delete(changedKey);
  }
  if (aiTab === changedKey && aiOpen()) setAiTab(changedKey);
  renderSlotUi();
}

function renderSlotUi() {
  const custom = aiSites.custom;
  if (custom && document.activeElement !== el.slotLabel && document.activeElement !== el.slotUrl) {
    el.slotLabel.value = custom.label || '';
    el.slotUrl.value = custom.url || '';
  }
  const mailUrl = aiSites.mail?.url;
  el.mailPick.innerHTML = mailProviders
    .map(
      (p) =>
        `<button type="button" data-mail="${esc(p.id)}"${p.url === mailUrl ? ' class="is-on"' : ''}>${esc(p.label)}</button>`
    )
    .join('');
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
const PANE_ANIM_MS = 320;
const aiViews = new Map(); // key -> <webview>
let aiSites = {};
let mailProviders = [];
let aiTab = 'chatgpt';

/** Tab labels come from settings, so the strip is rebuilt whenever they change. */
function renderAiTabs() {
  $$('button', el.aiSeg).forEach((b) => {
    const site = aiSites[b.dataset.ai];
    if (site) {
      b.textContent = site.label;
      b.title = site.url;
    }
  });
}

/**
 * A slot pointed at Google mail hits the same embedded-browser block as
 * "Sign in with Google", so the warning follows the URL, not the tab name.
 */
function isGoogleOnly(key) {
  try {
    return new URL(aiSites[key].url).hostname.endsWith('google.com');
  } catch (_) {
    return false;
  }
}

let aiCloseTimer = null;
const aiOpen = () => !el.ai.hidden && !el.ai.classList.contains('is-closing');

function animateAiBody() {
  el.aiBody.classList.remove('is-switching');
  void el.aiBody.offsetWidth;
  el.aiBody.classList.add('is-switching');
}

/**
 * Google blocks sign-in inside embedded browser frameworks. Which advice is
 * useful depends on whether the site offers a non-Google way in.
 */
function showGoogleNote(key) {
  if (isGoogleOnly(key)) {
    el.aiNoteTitle.textContent = `${aiSites[key].label} can only be signed in from a real browser.`;
    el.aiNoteBody.textContent =
      ' Google blocks sign-in inside embedded panes, and Google mail has no other way in. Open it in a browser window — that session stays there.';
    el.aiNoteCta.textContent = 'Open in browser';
    el.aiNoteCta.dataset.act = 'aiPopout';
  } else {
    el.aiNoteTitle.textContent = 'Google sign-in only works in a real browser';
    el.aiNoteBody.textContent =
      ', and that session stays there — it won’t sign you in here. Go back and use your email address instead.';
    el.aiNoteCta.textContent = 'Back to sign-in';
    el.aiNoteCta.dataset.act = 'aiBack';
  }
  el.aiNote.hidden = false;
}

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

  view.addEventListener('dom-ready', () => {
    view.dataset.ready = '1';
  });
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
    if (host.endsWith('accounts.google.com')) showGoogleNote(key);
  };
  view.addEventListener('did-navigate', checkGoogle);
  view.addEventListener('did-navigate-in-page', checkGoogle);

  el.aiBody.appendChild(view);
  aiViews.set(key, view);
  return view;
}

function setAiTab(key) {
  if (!aiSites[key]) return;
  // Picking a chat tab always leaves tool mode.
  if (activeTool) {
    activeTool = null;
    el.aiSeg.hidden = false;
    el.aiToolbar.hidden = true;
    if (toolView) toolView.hidden = true;
  }
  aiTab = key;
  el.aiSeg.dataset.on = key;
  $$('button', el.aiSeg).forEach((b) => b.classList.toggle('is-on', b.dataset.ai === key));

  hideAiState();
  el.aiNote.hidden = true;
  const view = ensureAiView(key);
  animateAiBody();
  aiViews.forEach((v, k) => {
    v.hidden = k !== key;
  });
  // isLoading() throws until the guest is attached and dom-ready has fired, so
  // a tab switched to immediately after creation must not be asked.
  try {
    if (view && view.dataset.ready === '1' && view.isLoading()) {
      showAiState(`Loading ${aiSites[key].label}…`);
    } else if (view && view.dataset.ready !== '1') {
      showAiState(`Loading ${aiSites[key].label}…`);
    }
  } catch (_) {
    /* not attached yet — the load events will settle the state */
  }
  api.ai.setTab(key);
}

/** `skipTab` opens the pane without booting a chat site — used by the tools. */
function openAiPane({ skipTab = false } = {}) {
  clearTimeout(aiCloseTimer);
  aiCloseTimer = null;
  if (!el.pop.hidden) closeWhen();
  if (!el.sheet.hidden) closeSheet();
  el.ai.hidden = false;
  el.ai.classList.remove('is-closing');
  el.html.classList.add('ai-mode');
  $('[data-act="ai"]').classList.add('is-on');
  if (!skipTab) setAiTab(aiTab);
  api.ai.setOpen(true);
}

function closeAiPane() {
  if (el.ai.hidden || el.ai.classList.contains('is-closing')) return;
  el.ai.classList.add('is-closing');
  $('[data-act="ai"]').classList.remove('is-on');
  api.ai.setOpen(false);
  clearTimeout(aiCloseTimer);
  aiCloseTimer = setTimeout(() => {
    el.ai.hidden = true;
    el.ai.classList.remove('is-closing');
    el.html.classList.remove('ai-mode');
    // Next open should start on the chat tabs, not a stale tool.
    activeTool = null;
    el.aiSeg.hidden = false;
    el.aiToolbar.hidden = true;
    if (toolView) toolView.hidden = true;
    aiCloseTimer = null;
  }, PANE_ANIM_MS);
}

const toggleAiPane = () => (aiOpen() ? closeAiPane() : openAiPane());

el.ai.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-ai]');
  if (tab) return setAiTab(tab.dataset.ai);

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'aiClose') closeAiPane();
  if (act === 'aiAsk') api.ask.show();
  if (act === 'toolBack') closeTool();
  if (act === 'aiNoteClose') el.aiNote.hidden = true;
  if (act === 'aiPopout') {
    if (activeTool) api.links.open(activeTool.url);
    else api.ai.popOut(aiTab);
  }
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
    const view = activeTool ? toolView : aiViews.get(aiTab);
    if (view) {
      hideAiState();
      el.aiNote.hidden = true;
      view.reload();
    }
  }
});

/* ── tool launcher ───────────────────────────────────────────────────── */

let tools = [];
let toolFilter = '';
let toolEditing = null; // tool id whose URL row is open
let toolView = null; // one reusable webview for every tool
let activeTool = null;

const prettyUrl = (u) => String(u).replace(/^https?:\/\//, '').replace(/\/$/, '');

function renderTools() {
  const q = toolFilter.trim().toLowerCase();
  const list = q
    ? tools.filter((t) => t.label.toLowerCase().includes(q) || t.cat.toLowerCase().includes(q))
    : tools;

  if (!list.length) {
    el.toolList.innerHTML = `<div class="empty">${ICON('i-search')}
      <p class="empty-t">No tool matches</p>
      <p class="empty-s">Try “pdf”, “image” or “convert”.</p></div>`;
    return;
  }

  const rowHtml = (t) => {
    const editHtml =
      toolEditing === t.id
        ? t.userAdded
          ? `<div class="tool-edit tool-edit-added" data-tool="${esc(t.id)}">
              <input class="tool-name-input" type="text" value="${esc(t.label)}" placeholder="Tool name" maxlength="40" spellcheck="false" />
              <input class="tool-cat-input" type="text" value="${esc(t.cat)}" placeholder="Category" maxlength="24" spellcheck="false" />
              <input class="tool-url-input" type="text" value="${esc(t.url)}" placeholder="https://example.com" maxlength="400" spellcheck="false" />
              <button class="btn btn-primary" data-act="toolSave">Save</button>
            </div>`
          : `<div class="tool-edit" data-tool="${esc(t.id)}">
              <input class="tool-url-input" type="text" value="${esc(t.url)}" spellcheck="false"
                     placeholder="https://example.com" maxlength="400" />
              <button class="btn btn-primary" data-act="toolSave">Save</button>
            </div>`
        : '';
    return `<div class="tool-row${t.custom || t.userAdded ? ' is-custom' : ''}" data-tool="${esc(t.id)}">
      <div class="body">
        <div class="tool-name">${esc(t.label)}</div>
        <div class="tool-url">${esc(prettyUrl(t.url))}</div>
      </div>
      <div class="tool-acts">
        <button class="tool-fav${t.favorite ? ' is-on' : ''}" data-act="toolFavorite" title="${t.favorite ? 'Remove from favourites' : 'Add to favourites'}">${ICON('i-star')}</button>
        <button data-act="toolEdit" title="${t.userAdded ? 'Edit this tool' : 'Change the site this opens'}">${ICON('i-pencil')}</button>
        ${t.custom && !t.userAdded ? `<button data-act="toolReset" title="Restore the default">${ICON('i-undo')}</button>` : ''}
        ${t.userAdded ? `<button data-act="toolDelete" title="Delete this custom tool">${ICON('i-trash')}</button>` : ''}
      </div>
    </div>${editHtml}`;
  };

  let html = '';
  const favorites = list.filter((t) => t.favorite);
  if (favorites.length) {
    html += `<div class="group-label tool-favorite-label">${ICON('i-star')}Favorites</div>`;
    html += favorites.map(rowHtml).join('');
  }
  const grouped = new Map();
  for (const t of list.filter((tool) => !tool.favorite)) {
    if (!grouped.has(t.cat)) grouped.set(t.cat, []);
    grouped.get(t.cat).push(t);
  }
  for (const [cat, entries] of grouped) {
    html += `<div class="group-label">${esc(cat)}</div>`;
    html += entries.map(rowHtml).join('');
  }
  el.toolList.innerHTML = html;

  if (toolEditing) {
    const input = $('.tool-name-input', el.toolList) || $('.tool-url-input', el.toolList);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

async function loadTools() {
  try {
    tools = (await api.tools.list()) || [];
  } catch (_) {
    tools = [];
  }
  renderTools();
}

/** Tools share one webview: switching tool just navigates it. */
function ensureToolView(url) {
  if (toolView) return toolView;
  const view = document.createElement('webview');
  view.setAttribute('partition', AI_PARTITION);
  view.setAttribute('allowpopups', '');
  view.setAttribute('src', url);
  view.classList.add('is-tool');

  view.addEventListener('dom-ready', () => {
    view.dataset.ready = '1';
  });
  view.addEventListener('did-start-loading', () => {
    if (activeTool) showAiState('Loading…');
  });
  view.addEventListener('did-stop-loading', () => {
    if (activeTool) hideAiState();
  });
  view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return;
    if (activeTool) showAiState("Couldn't load this tool. Check the address or your connection.", true);
  });

  el.aiBody.appendChild(view);
  toolView = view;
  return view;
}

function openTool(id) {
  const tool = tools.find((t) => t.id === id);
  if (!tool) return;

  activeTool = tool;
  closeSheet();

  if (!aiOpen()) openAiPane({ skipTab: true });
  el.aiSeg.hidden = true;
  el.aiToolbar.hidden = false;
  el.aiToolName.textContent = tool.label;
  el.aiNote.hidden = true;

  // Park the chat views and show the tool one.
  aiViews.forEach((v) => {
    v.hidden = true;
  });
  const createdView = !toolView;
  const view = ensureToolView(tool.url);
  animateAiBody();
  view.hidden = false;
  showAiState(`Loading ${tool.label}…`);

  let current = '';
  try {
    current = view.getURL();
  } catch (_) {
    current = '';
  }
  if (!createdView && current !== tool.url) view.loadURL(tool.url);
}

/** Leave tool mode and put the chat tabs back. */
function closeTool() {
  activeTool = null;
  el.aiSeg.hidden = false;
  el.aiToolbar.hidden = true;
  if (toolView) toolView.hidden = true;
  hideAiState();
  setAiTab(aiTab);
}

el.toolSearch.addEventListener('input', () => {
  toolFilter = el.toolSearch.value;
  toolEditing = null;
  renderTools();
});

el.toolList.addEventListener('click', async (e) => {
  const row = e.target.closest('[data-tool]');
  if (!row) return;
  const id = row.dataset.tool;
  const act = e.target.closest('[data-act]')?.dataset.act;

  if (act === 'toolFavorite') {
    const tool = tools.find((t) => t.id === id);
    const res = await api.tools.favorite(id, !tool?.favorite);
    if (res?.ok) tools = res.tools;
    return renderTools();
  }
  if (act === 'toolEdit') {
    toolEditing = toolEditing === id ? null : id;
    return renderTools();
  }
  if (act === 'toolReset') {
    const res = await api.tools.setUrl(id, '');
    if (res?.ok) tools = res.tools;
    toolEditing = null;
    return renderTools();
  }
  if (act === 'toolDelete') {
    const res = await api.tools.remove(id);
    if (res?.ok) {
      tools = res.tools;
      toolEditing = null;
      if (activeTool?.id === id) closeTool();
      return renderTools();
    }
    return showToast(res?.error || 'Could not delete that tool', null);
  }
  if (act === 'toolSave') {
    const wrap = row.classList.contains('tool-edit') ? row : row.closest('.tool-edit');
    const tool = tools.find((t) => t.id === id);
    const res = tool?.userAdded
      ? await api.tools.update(id, {
          label: $('.tool-name-input', wrap)?.value,
          cat: $('.tool-cat-input', wrap)?.value,
          url: $('.tool-url-input', wrap)?.value,
        })
      : await api.tools.setUrl(id, $('.tool-url-input', wrap)?.value || '');
    if (res?.ok) {
      tools = res.tools;
      toolEditing = null;
      renderTools();
    } else {
      showToast(res?.error || 'That address looks wrong', null);
    }
    return;
  }
  if (row.classList.contains('tool-row')) openTool(id);
});

el.toolList.addEventListener('keydown', (e) => {
  if (!e.target.closest('.tool-edit')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const wrap = e.target.closest('.tool-edit');
    if (wrap) $('[data-act="toolSave"]', wrap)?.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    toolEditing = null;
    renderTools();
  }
});

function closeToolAdd() {
  el.toolAdd.hidden = true;
  el.toolAddMsg.textContent = '';
  el.toolAddMsg.classList.remove('is-bad');
}

el.toolAddButton.addEventListener('click', () => {
  const opening = el.toolAdd.hidden;
  if (!opening) return closeToolAdd();
  el.toolAdd.hidden = false;
  el.toolAddMsg.textContent = '';
  el.toolAddName.focus();
});

el.toolAddCancel.addEventListener('click', closeToolAdd);

el.toolAddSave.addEventListener('click', async () => {
  const res = await api.tools.add({
    label: el.toolAddName.value,
    url: el.toolAddUrl.value,
    cat: el.toolAddCat.value,
  });
  if (!res?.ok) {
    el.toolAddMsg.textContent = res?.error || 'Could not add that tool';
    el.toolAddMsg.classList.add('is-bad');
    return;
  }
  tools = res.tools;
  el.toolAddName.value = '';
  el.toolAddUrl.value = '';
  el.toolAddCat.value = '';
  toolFilter = '';
  el.toolSearch.value = '';
  closeToolAdd();
  renderTools();
});

el.toolAdd.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.toolAddSave.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeToolAdd();
  }
});

/* ── header actions ──────────────────────────────────────────────────── */

$('.head-actions').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'collapse') api.dock.collapse();
  else if (act === 'theme') cycleTheme();
  else if (act === 'ai') toggleAiPane();
  else if (act === 'menu') (el.sheet.hidden ? openSheet('archive') : closeSheet());
  else if (act === 'tools') {
    // Straight to the launcher; clicking again closes it.
    const onTools = !el.sheet.hidden && $('[data-pane="tools"]') && !$('[data-pane="tools"]').hidden;
    if (onTools) closeSheet();
    else openSheet('tools');
  } else if (act === 'screen') api.dock.cycleDisplay();
});

$('[data-act="when"]').addEventListener('click', () => (el.pop.hidden ? openWhen() : closeWhen()));
$('[data-act="cat"]').addEventListener('click', () => (el.catPop.hidden ? openCat() : closeCat()));

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
    if (!el.catPop.hidden) return closeCat();
    if (!el.sheet.hidden) return closeSheet();
    if (aiOpen()) return closeAiPane();
    if (editingId) return;
    return api.dock.collapse();
  }
  if (e.ctrlKey && ['1', '2', '3'].includes(e.key)) {
    e.preventDefault();
    setView({ 1: 'schedule', 2: 'notes', 3: 'links' }[e.key]);
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
  if (!el.catPop.hidden && !el.catPop.contains(e.target) && !e.target.closest('[data-act="cat"], #chipCat')) {
    closeCat();
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
  const [loaded, s, metrics, sites, providers] = await Promise.all([
    api.data.load(),
    api.settings.get(),
    api.dock.metrics(),
    api.ai.sites(),
    api.ai.providers(),
  ]);

  aiSites = sites || {};
  mailProviders = providers || [];
  if (aiSites[s.aiTab]) aiTab = s.aiTab;
  renderAiTabs();

  data = loaded && Array.isArray(loaded.items) ? loaded : { version: 1, items: [] };
  // Legacy shape from an earlier build.
  if (Array.isArray(loaded?.events) || Array.isArray(loaded?.tasks)) {
    data.items = [
      ...(loaded.events || []).map((i) => ({ ...i, kind: 'event' })),
      ...(loaded.tasks || []).map((i) => ({ ...i, kind: 'task' })),
    ];
  }
  // Links arrived in 1.2 — older data files simply don't have the array.
  if (!Array.isArray(data.links)) data.links = [];
  data.items.forEach((i) => seenIds.add(i.id));
  data.links.forEach((l) => seenIds.add(l.id));

  settings = s;
  view = ['notes', 'links'].includes(s.view) ? s.view : 'schedule';
  applyViewChrome();

  applyDock(metrics);
  syncSettingsUi();
  renderSlotUi();
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
