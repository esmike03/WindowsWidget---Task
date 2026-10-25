'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Sidenote renderer
   Item = { id, kind:'event'|'task'|'note', title, content, checklist, at:number|null, done, doneAt,
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
  collapseBtn: $('[data-act="collapse"]'),
  panel: $('#panel'),
  grip: $('#grip'),
  weekday: $('#hWeekday'),
  date: $('#hDate'),
  sub: $('#hSub'),
  seg: $('#seg'),
  cSchedule: $('#cSchedule'),
  cNotes: $('#cNotes'),
  cTasks: $('#cTasks'),
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
  noteEditor: $('#noteEditor'),
  noteEditorHeading: $('#noteEditorHeading'),
  noteTitle: $('#noteTitle'),
  noteContent: $('#noteContent'),
  noteDropzone: $('#noteDropzone'),
  noteChecklist: $('#noteChecklist'),
  noteFontSize: $('#noteFontSize'),
  noteHighlightMenu: $('#noteHighlightMenu'),
  noteImageInput: $('#noteImageInput'),
  noteStatus: $('#noteStatus'),
};

let data = { version: 3, items: [], links: [] };
let settings = {};
let view = 'schedule';
let manualWhen = null; // { at: number|null } — overrides text parsing until submit
let manualCat = null; // string | '' (unsorted) | null — same idea for link categories
let editingId = null;
let seenIds = new Set();
let noteEditingId = null;
let noteSelection = null;
let noteUndoStack = [];
let noteUndoBytes = 0;
let noteUndoStamp = { at: 0, key: '' };
let restoringNote = false;
let noteObservedSnapshot = null;
let noteBeforeInputRecorded = false;

const COMPLETE_DELAY = 1500; // strike-through dwell before the item leaves
const NOTE_UNDO_LIMIT_BYTES = 4 * 1024 * 1024;
const NOTE_UNDO_LIMIT_STEPS = 40;
const pending = new Map(); // id -> { timer, prevKind }
let toastTimer = null;
let undoAction = null;

// Date parsing is shared with the quick-capture bar — see parse.js, loaded
// ahead of this script.
const { parseWhen, startOfDay, DAY } = window.SidenoteParse;

/* ── helpers ─────────────────────────────────────────────────────────── */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Notes are stored as a deliberately small HTML subset. This keeps formatting
 * useful while preventing pasted markup from turning into executable UI.
 */
function sanitizeNoteHtml(raw) {
  const template = document.createElement('template');
  template.innerHTML = String(raw || '');
  const allowed = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'MARK', 'FONT', 'IMG']);

  // Attributes needed by the allowed nodes must be captured before the blanket
  // removal above.
  for (const img of template.content.querySelectorAll('img')) img.dataset.safeSrc = img.getAttribute('src') || '';
  for (const font of template.content.querySelectorAll('font')) font.dataset.safeSize = font.getAttribute('size') || '3';
  for (const mark of template.content.querySelectorAll('mark')) mark.dataset.safeClass = mark.className || 'hl-yellow';

  const cleanWithSavedAttrs = (root) => {
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      cleanWithSavedAttrs(node);
      if (!allowed.has(node.tagName)) {
        node.replaceWith(...node.childNodes);
        continue;
      }
      const src = node.dataset.safeSrc;
      const size = node.dataset.safeSize;
      const markClass = node.dataset.safeClass;
      for (const attr of Array.from(node.attributes)) node.removeAttribute(attr.name);
      if (node.tagName === 'IMG') {
        if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(src || '')) {
          node.remove();
          continue;
        }
        node.setAttribute('src', src);
        node.setAttribute('alt', 'Note image');
      } else if (node.tagName === 'FONT') {
        node.setAttribute('size', String(Math.max(1, Math.min(7, Number(size) || 3))));
      } else if (node.tagName === 'MARK') {
        const color = ['yellow', 'mint', 'blue', 'pink'].find((name) => markClass === `hl-${name}`) || 'yellow';
        node.className = `hl-${color}`;
      }
    }
  };
  cleanWithSavedAttrs(template.content);
  return template.innerHTML;
}

function noteSummary(html) {
  const box = document.createElement('div');
  box.innerHTML = sanitizeNoteHtml(html);
  return {
    text: (box.textContent || '').replace(/\s+/g, ' ').trim(),
    images: box.querySelectorAll('img').length,
  };
}

const notePlainText = (html) => noteSummary(html).text;
const noteSummaryCache = new Map();

function cachedNoteSummary(note) {
  const stamp = `${note.updatedAt || note.createdAt || 0}:${String(note.content || '').length}`;
  const cached = noteSummaryCache.get(note.id);
  if (cached?.stamp === stamp) return cached.summary;
  const summary = noteSummary(note.content);
  noteSummaryCache.set(note.id, { stamp, summary });
  return summary;
}

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

/**
 * An item saved from the floating quick-capture bar. The main process has
 * already written it; we mirror it into our copy so the next full save from
 * this window doesn't overwrite it back out of existence.
 */
api.data.onAdded((item) => {
  if (!item || !item.id || find(item.id)) return;
  data.items.push(item);
  renderCounts();
  renderHeader();
  renderList();
});

api.data.onReplaced((next) => {
  if (!next || !Array.isArray(next.items)) return;
  clearTimeout(saveTimer); // a pending save of the old copy would undo the change
  data = { ...next, links: Array.isArray(next.links) ? next.links : [] };
  data.items.forEach((i) => seenIds.add(i.id));
  data.links.forEach((l) => seenIds.add(l.id));
  renderAll();
  if (!el.sheet.hidden) renderArchive();
});

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

function noteHtml(note) {
  const cls = ['item', 'is-note'];
  if (!seenIds.has(note.id)) cls.push('entering');
  seenIds.add(note.id);

  const checklist = Array.isArray(note.checklist) ? note.checklist : [];
  const checked = checklist.filter((entry) => entry.done).length;
  const summary = cachedNoteSummary(note);
  const preview = summary.text;
  const imageCount = summary.images;
  const details = [];
  if (checklist.length) details.push(`${checked}/${checklist.length} checked`);
  if (imageCount) details.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`);
  details.push(`Edited ${relative(note.updatedAt || note.createdAt)}`);

  return `<article class="${cls.join(' ')}" data-id="${note.id}" tabindex="0">
    <span class="note-card-icon" aria-hidden="true">${ICON('i-note')}</span>
    <div class="body">
      <div class="row1"><span class="title">${esc(note.title || 'Untitled note')}</span></div>
      <div class="note-preview">${esc(preview || (checklist.length ? 'Checklist note' : 'Empty note'))}</div>
      <div class="meta note-card-meta">${esc(details.join(' · '))}</div>
      ${
        checklist.length
          ? `<div class="note-progress"><i data-done="${checked}" data-total="${checklist.length}"></i></div>`
          : ''
      }
    </div>
    <div class="acts">
      <button data-act="edit" title="Open note">${ICON('i-pencil')}</button>
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

  if (view === 'notes') {
    const list = live('note').sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    el.list.innerHTML = list.map(noteHtml).join('');
    $$('.note-progress i', el.list).forEach((bar) => {
      const total = Number(bar.dataset.total) || 0;
      const done = Number(bar.dataset.done) || 0;
      bar.style.setProperty('--note-progress', `${total ? (done / total) * 100 : 0}%`);
    });
    el.empty.hidden = list.length > 0;
    if (!list.length) {
      $('.empty-t', el.empty).textContent = 'No notes yet';
      $('.empty-s', el.empty).textContent = 'Create a note with rich text, checklists, highlights and images.';
      $('.empty svg use', el.empty)?.setAttribute('href', '#i-note');
    }
    renderCounts();
    return;
  }

  if (view === 'schedule' && calMode === 'month') return renderCalendar();

  const kind = view === 'schedule' ? 'event' : 'task';
  const list = live(kind);
  const nextId = nextUpId(list);
  const groups = buildGroups(list);

  el.list.innerHTML = (view === 'schedule' ? calSwitchHtml() : '') + groups
    .map(
      (g) =>
        `<div class="group-label${g.late ? ' is-late' : ''}">${esc(g.label)}</div>` +
        g.items.map((i) => itemHtml(i, nextId)).join('')
    )
    .join('');

  const isEmpty = list.length === 0;
  el.empty.hidden = !isEmpty;
  if (isEmpty) {
    $('.empty-t', el.empty).textContent = view === 'schedule' ? 'No events scheduled' : 'No tasks yet';
    $('.empty-s', el.empty).textContent =
      view === 'schedule'
        ? 'Add a meeting below — try “review tomorrow 2pm”.'
        : 'Add a task below. A due date is optional.';
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

/* ── calendar (Schedule → Month) ─────────────────────────────────────── */

let calMode = 'list'; // list | month
let calMonth = null; // first day of the shown month (ms)
let calDay = null; // selected day (start of day, ms)

function calSwitchHtml() {
  const on = (m) => (calMode === m ? ' class="is-on"' : '');
  return `<div class="cal-switch" role="tablist">
    <button type="button" data-cal-mode="list"${on('list')}>List</button>
    <button type="button" data-cal-mode="month"${on('month')}>Month</button>
  </div>`;
}

function monthStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Events and dated tasks on the calendar, keyed by start of day. */
function datedByDay() {
  const map = new Map();
  for (const i of data.items) {
    if (i.archived || (i.kind !== 'event' && i.kind !== 'task') || !Number.isFinite(i.at)) continue;
    const key = startOfDay(i.at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  }
  return map;
}

function renderCalendar() {
  const today = startOfDay(Date.now());
  if (calDay == null) calDay = today;
  if (calMonth == null) calMonth = monthStart(calDay);

  const byDay = datedByDay();
  const first = new Date(calMonth);
  const year = first.getFullYear();
  const month = first.getMonth();
  const lead = first.getDay(); // Sunday-first grid
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;

  const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span>${d}</span>`).join('');
  let grid = '';
  for (let c = 0; c < cells; c += 1) {
    const day = new Date(year, month, c - lead + 1).getTime();
    const inMonth = c >= lead && c < lead + daysInMonth;
    const list = byDay.get(day) || [];
    const events = list.filter((i) => i.kind === 'event' && !i.done).length;
    const tasks = list.filter((i) => i.kind === 'task' && !i.done).length;
    const cls = ['cal-day'];
    if (!inMonth) cls.push('is-out');
    if (day === today) cls.push('is-today');
    if (day === calDay) cls.push('is-sel');
    if (day < today && list.some((i) => !i.done)) cls.push('is-late');
    const dots = (events ? '<i class="dot-ev"></i>' : '') + (tasks ? '<i class="dot-tk"></i>' : '');
    const label = new Date(day).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const count = events + tasks;
    const tip = `${label}${count ? ` — ${count} item${count === 1 ? '' : 's'}` : ''}`;
    grid += `<button type="button" class="${cls.join(' ')}" data-day="${day}" title="${esc(tip)}"><span>${new Date(day).getDate()}</span><span class="cal-dots">${dots}</span></button>`;
  }

  const dayItems = (byDay.get(calDay) || []).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return a.at - b.at;
  });
  const nextId = nextUpId(live('event'));
  const dayLabel =
    calDay === today
      ? 'Today'
      : calDay === today + DAY
        ? 'Tomorrow'
        : new Date(calDay).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const monthLabel = first.toLocaleDateString([], { month: 'long', year: 'numeric' });

  el.list.innerHTML = `${calSwitchHtml()}
    <section class="cal">
      <header class="cal-head">
        <strong>${esc(monthLabel)}</strong>
        <button type="button" class="cal-today" data-cal-nav="0">Today</button>
        <button type="button" class="ico cal-prev" data-cal-nav="-1" title="Previous month">${ICON('i-back')}</button>
        <button type="button" class="ico" data-cal-nav="1" title="Next month">${ICON('i-chevron')}</button>
      </header>
      <div class="cal-week">${weekdays}</div>
      <div class="cal-grid">${grid}</div>
    </section>
    <div class="group-label">${esc(dayLabel)}</div>
    ${dayItems.length
      ? dayItems.map((i) => itemHtml(i, nextId)).join('')
      : '<p class="cal-empty">Nothing on this day. Type below to add an event here.</p>'}`;
  el.empty.hidden = true;
  if (editingId) {
    const input = $('.title-edit', el.list);
    if (input) {
      input.focus();
      input.select();
    }
  }
  renderCounts();
  refreshCalendarComposer();
}

function refreshCalendarComposer() {
  if (view !== 'schedule') return;
  const today = startOfDay(Date.now());
  if (calMode === 'month' && calDay != null && calDay !== today) {
    const d = new Date(calDay).toLocaleDateString([], { month: 'short', day: 'numeric' });
    el.input.placeholder = `Add an event on ${d}…`;
  } else {
    el.input.placeholder = PLACEHOLDER.schedule;
  }
}

const DATE_WORDS =
  /\b(today|tonight|tomorrow|tmrw|yesterday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|in\s+\d|\d{1,2}\/\d{1,2})/i;

/**
 * In Month view, new events land on the selected day: an undated entry gets
 * 9:00 that day, and a time-only entry ("standup 3pm") keeps its time but
 * moves from today to that day. Explicit dates still win.
 */
function onSelectedDay(at, raw) {
  if (view !== 'schedule' || calMode !== 'month' || calDay == null) return at;
  const today = startOfDay(Date.now());
  if (calDay === today) return at;
  if (at == null) return calDay + 9 * 3600_000;
  if (startOfDay(at) === today && !DATE_WORDS.test(raw)) {
    const d = new Date(at);
    const day = new Date(calDay);
    day.setHours(d.getHours(), d.getMinutes(), 0, 0);
    return day.getTime();
  }
  return at;
}

el.list.addEventListener('click', (e) => {
  const mode = e.target.closest('[data-cal-mode]');
  if (mode) {
    calMode = mode.dataset.calMode === 'month' ? 'month' : 'list';
    if (calMode === 'month') {
      calDay = startOfDay(Date.now());
      calMonth = monthStart(calDay);
    }
    api.settings.set({ scheduleMode: calMode });
    renderList();
    refreshCalendarComposer();
    refreshComposer();
    return;
  }
  const nav = e.target.closest('[data-cal-nav]');
  if (nav) {
    const step = Number(nav.dataset.calNav);
    if (step === 0) {
      calDay = startOfDay(Date.now());
      calMonth = monthStart(calDay);
    } else {
      const d = new Date(calMonth);
      calMonth = new Date(d.getFullYear(), d.getMonth() + step, 1).getTime();
    }
    renderList();
    refreshComposer();
    return;
  }
  const day = e.target.closest('[data-day]');
  if (day) {
    calDay = Number(day.dataset.day);
    if (monthStart(calDay) !== calMonth) calMonth = monthStart(calDay);
    renderList();
    refreshComposer();
    el.input.focus();
  }
});

function renderCounts() {
  const ev = live('event').filter((i) => !i.done).length;
  const nt = live('note').length;
  const tk = live('task').filter((i) => !i.done).length;
  const lk = links().length;
  el.cSchedule.textContent = ev;
  el.cNotes.textContent = nt;
  el.cTasks.textContent = tk;
  el.cLinks.textContent = lk;
  el.cSchedule.classList.toggle('is-zero', ev === 0);
  el.cNotes.classList.toggle('is-zero', nt === 0);
  el.cTasks.classList.toggle('is-zero', tk === 0);
  el.cLinks.classList.toggle('is-zero', lk === 0);

  // Tab badge counts what actually needs attention today.
  const soon = startOfDay(Date.now()) + DAY;
  const due = items().filter(
    (i) => (i.kind === 'event' || i.kind === 'task') && !i.archived && !i.done && i.at != null && i.at < soon
  ).length;
  el.tabBadge.hidden = due === 0;
  el.tabBadge.textContent = due > 99 ? '99+' : String(due);
}

function renderHeader() {
  const now = new Date();
  el.weekday.textContent = now.toLocaleDateString([], { weekday: 'long' });
  el.date.textContent = now.toLocaleDateString([], { day: 'numeric', month: 'short' });

  const upcoming = items()
    .filter(
      (i) =>
        (i.kind === 'event' || i.kind === 'task') &&
        !i.archived &&
        !i.done &&
        i.at != null &&
        i.at >= Date.now() - 60_000
    )
    .sort((a, b) => a.at - b.at)[0];
  const overdue = items().filter(
    (i) =>
      (i.kind === 'event' || i.kind === 'task') &&
      !i.archived &&
      !i.done &&
      i.at != null &&
      i.at < Date.now()
  ).length;

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
      <p class="empty-s">Completed events and tasks land here.</p></div>`;
    return;
  }

  el.archiveList.innerHTML = list
    .map(
      (i) => `<div class="arc-item" data-id="${i.id}">
      <span class="arc-kind">${ICON(i.kind === 'event' ? 'i-calendar' : i.kind === 'task' ? 'i-check' : 'i-note')}</span>
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

/* ── rich note editor ───────────────────────────────────────────────────── */

function readNoteChecklist() {
  return $$('.note-check-row', el.noteChecklist).map((row) => ({
    id: row.dataset.id || uid(),
    text: $('.note-check-text', row)?.value.trim() || '',
    done: !!$('.note-check-toggle', row)?.checked,
  }));
}

function noteEditorSnapshot() {
  return {
    title: el.noteTitle.value,
    content: el.noteContent.innerHTML,
    checklist: readNoteChecklist(),
  };
}

function syncNoteObservedState() {
  noteObservedSnapshot = noteEditorSnapshot();
}

function renderNoteChecklist(checklist = []) {
  el.noteChecklist.innerHTML = checklist
    .map(
      (entry) => `<div class="note-check-row${entry.done ? ' is-done' : ''}" data-id="${esc(entry.id || uid())}">
        <label class="note-check-box" title="Toggle item">
          <input class="note-check-toggle" type="checkbox"${entry.done ? ' checked' : ''} />
          <i>${ICON('i-check')}</i>
        </label>
        <input class="note-check-text" type="text" maxlength="240" value="${esc(entry.text || '')}" placeholder="Checklist item" />
        <button type="button" data-note-act="remove-check" title="Remove item">${ICON('i-x')}</button>
      </div>`
    )
    .join('');
}

function updateNoteUndoButton() {
  const button = $('[data-note-act="undo"]', el.noteEditor);
  if (button) button.disabled = noteUndoStack.length === 0;
}

function markNoteDirty() {
  el.noteStatus.textContent = 'Unsaved changes';
}

function recordNoteUndo(force = false, key = '', snapshot = null) {
  if (restoringNote) return;
  const now = Date.now();
  if (!force && noteUndoStamp.key === key && now - noteUndoStamp.at < 650) return;
  const value = snapshot || noteEditorSnapshot();
  const bytes = JSON.stringify(value).length * 2;
  noteUndoStack.push({ value, bytes });
  noteUndoBytes += bytes;
  while (
    noteUndoStack.length > 1 &&
    (noteUndoStack.length > NOTE_UNDO_LIMIT_STEPS || noteUndoBytes > NOTE_UNDO_LIMIT_BYTES)
  ) {
    noteUndoBytes -= noteUndoStack.shift().bytes;
  }
  noteUndoStamp = { at: now, key };
  updateNoteUndoButton();
}

function undoNote() {
  const entry = noteUndoStack.pop();
  if (!entry) return;
  noteUndoBytes = Math.max(0, noteUndoBytes - entry.bytes);
  const previous = entry.value;
  restoringNote = true;
  el.noteTitle.value = previous.title;
  el.noteContent.innerHTML = sanitizeNoteHtml(previous.content);
  renderNoteChecklist(previous.checklist);
  restoringNote = false;
  noteUndoStamp = { at: 0, key: '' };
  markNoteDirty();
  updateNoteUndoButton();
  syncNoteObservedState();
  el.noteContent.focus();
}

function addNoteChecklistItem(afterId = null, text = '') {
  recordNoteUndo(true, 'checklist-add');
  const list = readNoteChecklist();
  const entry = { id: uid(), text, done: false };
  const index = afterId ? list.findIndex((item) => item.id === afterId) : -1;
  if (index >= 0) list.splice(index + 1, 0, entry);
  else list.push(entry);
  renderNoteChecklist(list);
  markNoteDirty();
  syncNoteObservedState();
  const row = el.noteChecklist.querySelector(`[data-id="${entry.id}"]`);
  $('.note-check-text', row)?.focus();
}

function saveNoteSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (el.noteContent.contains(range.commonAncestorContainer)) noteSelection = range.cloneRange();
}

function restoreNoteSelection() {
  el.noteContent.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  if (noteSelection && el.noteContent.contains(noteSelection.commonAncestorContainer)) {
    selection.addRange(noteSelection);
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el.noteContent);
  range.collapse(false);
  selection.addRange(range);
}

function applyNoteCommand(command, value = null) {
  recordNoteUndo(true, `format-${command}`);
  restoreNoteSelection();
  document.execCommand(command, false, value);
  saveNoteSelection();
  markNoteDirty();
  syncNoteObservedState();
}

function applyNoteHighlight(color) {
  recordNoteUndo(true, `highlight-${color}`);
  restoreNoteSelection();
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  const selected = sanitizeNoteHtml(holder.innerHTML) || '&#8203;';
  document.execCommand('insertHTML', false, `<mark class="hl-${color}">${selected}</mark>`);
  el.noteHighlightMenu.hidden = true;
  saveNoteSelection();
  markNoteDirty();
  syncNoteObservedState();
}

function insertNoteImage(dataUrl) {
  recordNoteUndo(true, 'image');
  restoreNoteSelection();
  document.execCommand('insertImage', false, dataUrl);
  document.execCommand('insertHTML', false, '<div><br></div>');
  saveNoteSelection();
  markNoteDirty();
  syncNoteObservedState();
}

function readImageFile(file) {
  if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(file.type)) return Promise.reject(new Error('Unsupported image'));
  if (file.size > 8 * 1024 * 1024) return Promise.reject(new Error('Image is larger than 8 MB'));

  const asDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });

  // Keep animated GIFs intact, but cap them more tightly because they cannot be
  // resized without discarding animation frames.
  if (file.type.toLowerCase() === 'image/gif') {
    if (file.size > 2 * 1024 * 1024) return Promise.reject(new Error('Animated images must be smaller than 2 MB'));
    return asDataUrl(file);
  }

  return (async () => {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: true });
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const encode = (quality) =>
        new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
      let blob = await encode(0.82);
      if (!blob) throw new Error('Could not compress image');
      if (blob.size > 2.5 * 1024 * 1024) blob = await encode(0.68);
      if (!blob || blob.size > 3 * 1024 * 1024) throw new Error('Compressed image is still too large');
      return asDataUrl(blob);
    } finally {
      bitmap.close();
    }
  })();
}

async function addNoteImages(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  for (const file of files) {
    try {
      insertNoteImage(await readImageFile(file));
    } catch (error) {
      showToast(error.message || 'Could not add that image', null);
    }
  }
}

function openNoteEditor(id = null, initialTitle = '') {
  const note = id ? find(id) : null;
  noteEditingId = note?.kind === 'note' ? note.id : null;
  el.noteEditorHeading.textContent = noteEditingId ? 'Edit note' : 'New note';
  el.noteTitle.value = note?.title || initialTitle;
  el.noteContent.innerHTML = sanitizeNoteHtml(note?.content || '');
  renderNoteChecklist(Array.isArray(note?.checklist) ? note.checklist : []);
  el.noteStatus.textContent = 'Changes are saved when you press Save';
  el.noteHighlightMenu.hidden = true;
  el.noteImageInput.value = '';
  noteSelection = null;
  noteUndoStack = [];
  noteUndoBytes = 0;
  noteUndoStamp = { at: 0, key: '' };
  noteBeforeInputRecorded = false;
  syncNoteObservedState();
  updateNoteUndoButton();
  el.noteEditor.hidden = false;
  requestAnimationFrame(() => {
    if (!el.noteTitle.value) el.noteTitle.focus();
    else {
      el.noteContent.focus();
      restoreNoteSelection();
    }
  });
}

function closeNoteEditor() {
  el.noteHighlightMenu.hidden = true;
  el.noteEditor.classList.add('is-out');
  setTimeout(() => {
    el.noteEditor.hidden = true;
    el.noteEditor.classList.remove('is-out');
    noteEditingId = null;
    noteSelection = null;
    noteUndoStack = [];
    noteUndoBytes = 0;
    noteObservedSnapshot = null;
    noteBeforeInputRecorded = false;
    renderAll();
    el.input.focus();
  }, 180);
}

function saveOpenNote() {
  const content = sanitizeNoteHtml(el.noteContent.innerHTML);
  const checklist = readNoteChecklist().filter((entry) => entry.text);
  const plain = notePlainText(content);
  const title = el.noteTitle.value.trim() || plain.slice(0, 80) || 'Untitled note';
  let note = noteEditingId ? find(noteEditingId) : null;

  if (note?.kind === 'note') {
    note.title = title;
    note.content = content;
    note.checklist = checklist;
    note.noteVersion = 1;
    note.updatedAt = Date.now();
  } else {
    note = {
      id: uid(),
      kind: 'note',
      noteVersion: 1,
      title,
      content,
      checklist,
      at: null,
      done: false,
      doneAt: null,
      archived: false,
      archivedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      notified: true,
    };
    data.items.push(note);
  }
  data.version = 3;
  save();
  closeNoteEditor();
  showToast(`Saved · ${title}`, null);
}

el.noteEditor.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.note-toolbar button, .note-highlight-menu button')) saveNoteSelection();
  if (event.target.closest('.note-check-toggle')) recordNoteUndo(true, 'checklist-toggle');
});

el.noteEditor.addEventListener('click', (event) => {
  const command = event.target.closest('[data-note-cmd]')?.dataset.noteCmd;
  if (command) {
    applyNoteCommand(command);
    return;
  }

  const highlight = event.target.closest('[data-highlight]')?.dataset.highlight;
  if (highlight) {
    applyNoteHighlight(highlight);
    return;
  }

  const action = event.target.closest('[data-note-act]')?.dataset.noteAct;
  if (action === 'save') saveOpenNote();
  else if (action === 'cancel') closeNoteEditor();
  else if (action === 'undo') undoNote();
  else if (action === 'checklist') addNoteChecklistItem();
  else if (action === 'image') el.noteImageInput.click();
  else if (action === 'highlight') el.noteHighlightMenu.hidden = !el.noteHighlightMenu.hidden;
  else if (action === 'remove-check') {
    const row = event.target.closest('.note-check-row');
    if (!row) return;
    recordNoteUndo(true, 'checklist-remove');
    row.remove();
    markNoteDirty();
    syncNoteObservedState();
  }
});

el.noteFontSize.addEventListener('change', () => {
  applyNoteCommand('fontSize', el.noteFontSize.value);
  el.noteFontSize.value = '3';
});

el.noteEditor.addEventListener('beforeinput', (event) => {
  if (event.target === el.noteTitle) {
    recordNoteUndo(false, 'title');
    noteBeforeInputRecorded = true;
  } else if (event.target === el.noteContent) {
    recordNoteUndo(false, 'content');
    noteBeforeInputRecorded = true;
  }
  else if (event.target.classList?.contains('note-check-text')) {
    recordNoteUndo(false, `check-${event.target.closest('.note-check-row')?.dataset.id || ''}`);
    noteBeforeInputRecorded = true;
  }
});

el.noteEditor.addEventListener('input', (event) => {
  if (event.target.matches('#noteTitle, #noteContent, .note-check-text')) {
    if (!noteBeforeInputRecorded && noteObservedSnapshot) {
      recordNoteUndo(true, 'input-fallback', noteObservedSnapshot);
    }
    noteBeforeInputRecorded = false;
    markNoteDirty();
    syncNoteObservedState();
  }
  if (event.target.classList?.contains('note-check-toggle')) {
    event.target.closest('.note-check-row')?.classList.toggle('is-done', event.target.checked);
    markNoteDirty();
    syncNoteObservedState();
  }
});

el.noteEditor.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveOpenNote();
    return;
  }
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undoNote();
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'b' && event.target === el.noteContent) {
    event.preventDefault();
    saveNoteSelection();
    applyNoteCommand('bold');
    return;
  }
  if (event.target.classList?.contains('note-check-toggle') && (event.key === ' ' || event.key === 'Enter')) {
    recordNoteUndo(true, 'checklist-toggle');
  }

  const checkInput = event.target.closest('.note-check-text');
  if (checkInput && event.key === 'Enter') {
    event.preventDefault();
    addNoteChecklistItem(checkInput.closest('.note-check-row')?.dataset.id);
  } else if (checkInput && event.key === 'Backspace' && !checkInput.value) {
    const row = checkInput.closest('.note-check-row');
    const previous = row?.previousElementSibling;
    recordNoteUndo(true, 'checklist-remove');
    row?.remove();
    $('.note-check-text', previous)?.focus();
    markNoteDirty();
    syncNoteObservedState();
  }
});

document.addEventListener('selectionchange', () => {
  if (!el.noteEditor.hidden) saveNoteSelection();
});

el.noteImageInput.addEventListener('change', () => {
  addNoteImages(el.noteImageInput.files);
  el.noteImageInput.value = '';
});

el.noteContent.addEventListener('paste', (event) => {
  const imageFiles = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
  event.preventDefault();
  saveNoteSelection();
  if (imageFiles.length) {
    addNoteImages(imageFiles);
    return;
  }
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!text) return;
  recordNoteUndo(true, 'paste');
  restoreNoteSelection();
  document.execCommand('insertText', false, text);
  saveNoteSelection();
  markNoteDirty();
  syncNoteObservedState();
});

el.noteDropzone.addEventListener('dragover', (event) => {
  if (!Array.from(event.dataTransfer?.items || []).some((item) => item.type.startsWith('image/'))) return;
  event.preventDefault();
  el.noteDropzone.classList.add('is-dragging');
});

el.noteDropzone.addEventListener('dragleave', (event) => {
  if (!el.noteDropzone.contains(event.relatedTarget)) el.noteDropzone.classList.remove('is-dragging');
});

el.noteDropzone.addEventListener('drop', (event) => {
  const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'));
  el.noteDropzone.classList.remove('is-dragging');
  if (!files.length) return;
  event.preventDefault();
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && el.noteContent.contains(range.startContainer)) noteSelection = range.cloneRange();
  addNoteImages(files);
});

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
  const raw = el.input.value;
  const at = parseWhen(raw).at;
  return raw.trim() ? onSelectedDay(at, raw) : at;
}

function currentCat() {
  if (manualCat !== null) return manualCat;
  return parseLink(el.input.value).category ?? '';
}

function refreshComposer() {
  const text = el.input.value.trim();
  el.form.classList.toggle('has-text', text.length > 0);

  if (view === 'notes') {
    el.chipWhen.hidden = true;
    el.chipCat.hidden = true;
    el.parsed.hidden = true;
    return;
  }

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

  if (view === 'notes') {
    el.input.value = '';
    refreshComposer();
    openNoteEditor(null, raw);
    return;
  }

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
    at = onSelectedDay(parsed.at, raw);
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

  if (node.classList.contains('is-note')) {
    if (act === 'del') removeItem(id);
    else openNoteEditor(id);
    return;
  }

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
  if (!node || node.classList.contains('is-link') || node.classList.contains('is-note') || e.target.closest('button')) return;
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
  const note = e.target.closest('.is-note');
  if (note && !e.target.closest('button') && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openNoteEditor(note.dataset.id);
    return;
  }
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
  notes: 'New note title (optional)…',
  tasks: 'Add a task…',
  links: 'Paste a link…',
};
const HINT = {
  schedule: 'Try “standup tomorrow 9:30am”',
  notes: 'Press + to open the full note editor',
  tasks: 'Try “email Ana friday” — time is optional',
  links: 'Try “figma.com/file/x moodboard #design”',
};

function applyViewChrome() {
  el.html.dataset.view = view;
  $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));
  el.input.placeholder = PLACEHOLDER[view];
  refreshCalendarComposer();
  el.hint.textContent = HINT[view];
  $('[data-act="when"]').hidden = view !== 'schedule' && view !== 'tasks';
  $('[data-act="cat"]').hidden = view !== 'links';
  $('.ico-add', el.form).title = view === 'notes' ? 'Create note' : 'Add';
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

function openSheet(pane = 'settings') {
  el.sheet.hidden = false;
  el.sheet.classList.remove('is-out');
  setPane(pane);
  renderArchive();
  syncSettingsUi();
  if (pane === 'settings') refreshCodexUi();
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
  if (act === 'codexSign') return codexSignInOut();
  if (act === 'codexOpenAgain' && codexLoginUrl) return api.codex.openLogin(codexLoginUrl);
  if (act === 'codexFolder') {
    api.codex.pickFolder().then((folder) => folder && refreshCodexUi());
    return;
  }

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
    const value = key === 'reminderLeadMinutes' ? Number(pick.dataset.value) : pick.dataset.value;
    const done = applySettings({ [key]: value });
    if (key === 'chatgptMode') done.then(refreshCodexUi);
  }
});

el.sheet.addEventListener('change', (e) => {
  const key = e.target.dataset?.toggle;
  if (key) applySettings({ [key]: e.target.checked });
});

/* ── ChatGPT (Codex) connection ──────────────────────────────────────── */

let codexState = null;
let chatgptMode = 'codex'; // the connection in effect: codex | direct
const modelKey = () => (chatgptMode === 'direct' ? 'directModel' : 'codexModel');
const effortKey = () => (chatgptMode === 'direct' ? 'directEffort' : 'codexEffort');
let codexLoginUrl = null;
const EFFORT_LABEL = { low: 'Low — fastest', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max — slowest' };

/** Fills the Model and Thinking pickers from the models this account has. */
async function renderCodexModels() {
  const modelSel = $('#codexModel');
  const effortSel = $('#codexEffort');
  let info;
  try {
    info = chatgptMode === 'direct' ? await api.direct.models() : await api.codex.models();
  } catch (_) {
    info = { models: [], efforts: [] };
  }
  const models = info.models || [];
  const current = settings[modelKey()] || '';
  const nameOf = (id) => models.find((m) => m.id === id)?.name || id;
  const opts = [`<option value="">Default${info.configModel ? ` (${esc(nameOf(info.configModel))})` : ''}</option>`];
  for (const m of models) {
    opts.push(`<option value="${esc(m.id)}" title="${esc(m.description)}">${esc(m.name)}</option>`);
  }
  if (current && !models.some((m) => m.id === current)) opts.push(`<option value="${esc(current)}">${esc(current)}</option>`);
  modelSel.innerHTML = opts.join('');
  modelSel.value = current;

  const chosen = models.find((m) => m.id === (current || info.configModel));
  const efforts = chosen?.efforts?.length ? chosen.efforts : info.efforts || [];
  const effortNow = settings[effortKey()] || '';
  const fallback = info.configEffort || chosen?.defaultEffort;
  effortSel.innerHTML = [
    `<option value="">Default${fallback ? ` (${esc((EFFORT_LABEL[fallback] || fallback).split(' —')[0])})` : ''}</option>`,
    ...efforts.map((e) => `<option value="${e}">${esc(EFFORT_LABEL[e] || e)}</option>`),
  ].join('');
  effortSel.value = efforts.includes(effortNow) ? effortNow : '';
}

$('#codexModel').addEventListener('change', async (e) => {
  await applySettings({ [modelKey()]: e.target.value || null });
  renderCodexModels();
});
$('#codexEffort').addEventListener('change', (e) => applySettings({ [effortKey()]: e.target.value || null }));

api.codex.onLoginCode(({ url, code, browser }) => {
  codexLoginUrl = url;
  $('#codexCode').hidden = false;
  $('#codexCodeValue').textContent = code;
  $('#codexCodeWhere').textContent = browser ? browser[0].toUpperCase() + browser.slice(1) : 'your browser';
});
$('#codexCodeValue').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText(e.currentTarget.textContent);
    showToast('Code copied', null);
  } catch (_) {
    /* clipboard unavailable */
  }
});

async function refreshCodexUi() {
  const status = $('#codexStatus');
  const sign = $('#codexSign');
  const folder = $('#codexFolder');
  try {
    chatgptMode = await api.direct.mode();
  } catch (_) {
    chatgptMode = 'codex';
  }
  const group = status.closest('.set-group');
  group.dataset.chatgptMode = chatgptMode;
  $$('#chatgptModePick button').forEach((b) => b.classList.toggle('is-on', b.dataset.value === chatgptMode));
  if (chatgptMode === 'direct') return refreshDirectUi(status, sign, folder);
  let st;
  try {
    st = await api.codex.status();
  } catch (_) {
    st = { installed: false, signedIn: false };
  }
  codexState = st;
  status.classList.toggle('is-ok', !!st.signedIn);
  status.classList.toggle('is-bad', !st.installed);
  status.textContent = !st.installed
    ? 'Install Codex to connect ChatGPT: npm i -g @openai/codex'
    : st.signedIn
      ? st.method === 'chatgpt'
        ? 'Connected to your ChatGPT account. ChatGPT can read files in the folder below.'
        : 'Connected with an API key.'
      : 'Not signed in. Sign in with your ChatGPT account to use it from the Ask bar.';
  sign.hidden = !st.installed;
  sign.textContent = st.signedIn ? 'Sign out' : 'Sign in';
  sign.disabled = false;
  if (st.signedIn) $('#codexCode').hidden = true;
  renderCodexModels();
  if (st.folder) {
    folder.textContent = st.folder;
    folder.title = `${st.folder} — click to change`;
  }
}

let directState = null;

async function refreshDirectUi(status, sign, folder) {
  let st;
  try {
    st = await api.direct.status();
  } catch (_) {
    st = { signedIn: false };
  }
  directState = st;
  $('#codexCode').hidden = true;
  status.classList.toggle('is-ok', !!(st.signedIn && st.planUsage));
  status.classList.toggle('is-bad', !!(st.signedIn && !st.planUsage));
  status.textContent = !st.signedIn
    ? 'Not signed in. Sign in with your ChatGPT account; answers then use your ChatGPT plan. No Codex install needed.'
    : st.planUsage
      ? `Connected as ${st.email || 'your ChatGPT account'}. Answers use your ChatGPT plan; ChatGPT can read (not change) files in the folder below.`
      : 'Signed in, but using your ChatGPT plan wasn\'t allowed. Sign out and sign in again, and allow it.';
  sign.hidden = false;
  sign.textContent = st.signedIn ? 'Sign out' : 'Sign in';
  sign.disabled = false;
  const chosen = settings.askFolder;
  folder.textContent = chosen || 'Home folder';
  folder.title = `${chosen || 'Your home folder'} — click to change`;
  if (st.signedIn) renderCodexModels();
  else {
    $('#codexModel').innerHTML = '<option value="">Sign in to see models</option>';
    $('#codexEffort').innerHTML = '<option value="">Default</option>';
  }
}

async function codexSignInOut() {
  const sign = $('#codexSign');
  sign.disabled = true;
  if (chatgptMode === 'direct') {
    if (directState?.signedIn) {
      const res = await api.direct.signOut();
      if (res && !res.revoked) showToast('Signed out here. Also disconnect Sidenote in ChatGPT settings.', null);
    } else {
      sign.textContent = 'Finish in browser…';
      // After a fresh OpenAI log-in the browser can stop on OpenAI's own page.
      showToast('If the browser stops after you log in, click Sign in again.', null);
      const res = await api.direct.signIn();
      if (!res?.ok && res?.error) showToast(res.error.slice(0, 90), null);
    }
    refreshCodexUi();
    return;
  }
  if (codexState?.signedIn) {
    await api.codex.logout();
  } else {
    sign.textContent = 'Waiting for browser…';
    const res = await api.codex.login();
    if (!res?.ok && res?.error) showToast(res.error.slice(0, 80), null);
  }
  $('#codexCode').hidden = true;
  refreshCodexUi();
}

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
    destroyAiView(changedKey);
  }
  if (aiTab === changedKey && aiOpen()) setAiTab(changedKey);
  renderSlotUi();
}

function renderSlotUi() {
  const custom = aiSites.custom;
  if (custom && document.activeElement !== el.slotLabel && document.activeElement !== el.slotUrl) {
    el.slotLabel.value = custom.inputLabel || '';
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
    $$('button', p).forEach((b) => b.classList.toggle('is-on', String(b.dataset.value) === String(val)));
  });
  $$('[data-toggle]').forEach((t) => {
    t.checked = !!settings[t.dataset.toggle];
  });
  $('.reminder-lead')?.classList.toggle('is-disabled', !settings.reminders);
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

/* ── blur effect ─────────────────────────────────────────────────────── */

let wall = null; // { image, display } from the main process, or null when off

/** Line the wallpaper up with the desktop: offset = display origin − panel origin. */
function placeWall() {
  if (!wall) return;
  const r = el.panel.getBoundingClientRect();
  const x = Math.round(wall.display.x - (window.screenX + r.left));
  const y = Math.round(wall.display.y - (window.screenY + r.top));
  el.panel.style.setProperty('--wall-pos', `${x}px ${y}px`);
}

api.backdrop.onChange((payload) => {
  wall = payload && payload.image ? payload : null;
  el.html.classList.toggle('has-backdrop', !!wall);
  if (!wall) return;
  el.panel.style.setProperty('--wall-img', `url("${wall.image}")`);
  el.panel.style.setProperty('--wall-size', `${wall.display.width}px ${wall.display.height}px`);
  placeWall();
});
api.backdrop.onMove(placeWall);
window.addEventListener('resize', placeWall);
el.panel.addEventListener('transitionend', placeWall);

/* ── embedded AI browser ─────────────────────────────────────────────── */

const AI_PARTITION = 'persist:sidenote-ai';
const PANE_ANIM_MS = 320;
const AI_INACTIVE_IDLE_MS = 45_000;
const AI_CLOSED_IDLE_MS = 120_000;
const TOOL_IDLE_MS = 45_000;
const aiViews = new Map(); // key -> <webview>
const aiCleanupTimers = new Map();
let aiSites = {};
let mailProviders = [];
let aiTab = 'chatgpt';
let preconnectTimer = null;
let lastPreconnect = { origin: '', at: 0 };

function warmWebsite(url, delay = 0) {
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch (_) {
    return;
  }
  clearTimeout(preconnectTimer);
  preconnectTimer = setTimeout(() => {
    const now = Date.now();
    if (lastPreconnect.origin === origin && now - lastPreconnect.at < 30_000) return;
    lastPreconnect = { origin, at: now };
    api.web.preconnect(url).catch(() => {});
  }, delay);
}

function cancelAiCleanup(key) {
  clearTimeout(aiCleanupTimers.get(key));
  aiCleanupTimers.delete(key);
}

function destroyAiView(key) {
  cancelAiCleanup(key);
  const view = aiViews.get(key);
  if (!view) return;
  try {
    view.stop();
  } catch (_) {
    /* guest may already be detached */
  }
  view.remove();
  aiViews.delete(key);
}

function scheduleAiCleanup(key, delay) {
  cancelAiCleanup(key);
  if (!aiViews.has(key)) return;
  const timer = setTimeout(() => {
    aiCleanupTimers.delete(key);
    if (aiOpen() && !activeTool && aiTab === key) return;
    destroyAiView(key);
  }, delay);
  aiCleanupTimers.set(key, timer);
}

/** Tab labels come from settings, so the strip is rebuilt whenever they change. */
function renderAiTabs() {
  $$('button', el.aiSeg).forEach((b) => {
    const site = aiSites[b.dataset.ai];
    if (site) {
      b.textContent = site.label;
      b.title = site.url || 'Empty custom tab — set it up in Settings';
    }
  });
}

const warmAiFromEvent = (event) => {
  const button = event.target.closest('[data-ai]');
  const site = button ? aiSites[button.dataset.ai] : null;
  if (site?.url) warmWebsite(site.url, 140);
};
el.aiSeg.addEventListener('pointerover', warmAiFromEvent);
el.aiSeg.addEventListener('focusin', warmAiFromEvent);

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

function showAiState(text, isError = false, isEmpty = false) {
  el.aiStateText.textContent = text;
  el.aiState.classList.toggle('is-error', isError);
  el.aiState.classList.toggle('is-empty', isEmpty);
  el.aiState.hidden = false;
}
const hideAiState = () => {
  el.aiState.hidden = true;
  el.aiState.classList.remove('is-error', 'is-empty');
};

/** Webviews are created on first use so no chat site loads at startup. */
function ensureAiView(key) {
  if (aiViews.has(key)) return aiViews.get(key);
  const site = aiSites[key];
  if (!site || !site.url) return null;

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
  const previousTab = aiTab;
  // Picking a chat tab always leaves tool mode.
  if (activeTool) {
    activeTool = null;
    el.aiSeg.hidden = false;
    el.aiToolbar.hidden = true;
    if (toolView) toolView.hidden = true;
    scheduleToolCleanup();
  }
  aiTab = key;
  cancelAiCleanup(key);
  warmWebsite(aiSites[key].url);
  if (previousTab !== key) scheduleAiCleanup(previousTab, AI_INACTIVE_IDLE_MS);
  el.aiSeg.dataset.on = key;
  $$('button', el.aiSeg).forEach((b) => b.classList.toggle('is-on', b.dataset.ai === key));

  hideAiState();
  el.aiNote.hidden = true;
  const view = ensureAiView(key);
  animateAiBody();
  aiViews.forEach((v, k) => {
    v.hidden = k !== key;
  });
  if (!view && !aiSites[key].url) {
    showAiState('This custom tab is empty. Add a website in Settings when you want to use it.', false, true);
    api.ai.setTab(key);
    return;
  }
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
  if (!skipTab) cancelAiCleanup(aiTab);
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
    aiViews.forEach((_view, key) => {
      scheduleAiCleanup(key, key === aiTab ? AI_CLOSED_IDLE_MS : AI_INACTIVE_IDLE_MS);
    });
    scheduleToolCleanup();
    aiCloseTimer = null;
  }, PANE_ANIM_MS);
}

const toggleAiPane = () => (aiOpen() ? closeAiPane() : openAiPane());

el.ai.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-ai]');
  if (tab) return setAiTab(tab.dataset.ai);

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'aiClose') {
    if (activeTool) returnToToolsList();
    else closeAiPane();
  }
  if (act === 'aiAsk') api.ask.show();
  if (act === 'toolBack') returnToToolsList();
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
let toolCleanupTimer = null;

function destroyToolView() {
  clearTimeout(toolCleanupTimer);
  toolCleanupTimer = null;
  if (!toolView) return;
  try {
    toolView.stop();
  } catch (_) {
    /* guest may already be detached */
  }
  toolView.remove();
  toolView = null;
}

function scheduleToolCleanup(delay = TOOL_IDLE_MS) {
  clearTimeout(toolCleanupTimer);
  if (!toolView) return;
  toolCleanupTimer = setTimeout(() => {
    toolCleanupTimer = null;
    if (!activeTool) destroyToolView();
  }, delay);
}

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

  clearTimeout(toolCleanupTimer);
  toolCleanupTimer = null;
  warmWebsite(tool.url);
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
  scheduleToolCleanup();
  setAiTab(aiTab);
}

/** Close an open tool and restore the launcher instead of dropping into chats. */
function returnToToolsList() {
  if (!activeTool) return;
  closeAiPane();
  setTimeout(() => openSheet('tools'), PANE_ANIM_MS + 20);
}

el.toolSearch.addEventListener('input', () => {
  toolFilter = el.toolSearch.value;
  toolEditing = null;
  renderTools();
});

const warmToolFromEvent = (event) => {
  const row = event.target.closest('[data-tool]');
  if (!row) return;
  const tool = tools.find((entry) => entry.id === row.dataset.tool);
  if (tool) warmWebsite(tool.url, 140);
};
el.toolList.addEventListener('pointerover', warmToolFromEvent);
el.toolList.addEventListener('focusin', warmToolFromEvent);

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
  else if (act === 'menu') (el.sheet.hidden ? openSheet('settings') : closeSheet());
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
let dockCollapsed = true;

function applyDock(m) {
  dockCollapsed = !!m.collapsed;
  el.html.classList.toggle('collapsed', m.collapsed);
  const edge = m.edge === 'left' || m.edge === 'top' ? m.edge : 'right';
  el.html.classList.toggle('edge-left', edge === 'left');
  el.html.classList.toggle('edge-right', edge === 'right');
  el.html.classList.toggle('edge-top', edge === 'top');
  if (el.collapseBtn) {
    el.collapseBtn.title = m.trayOnly ? 'Hide to tray (Alt+Shift+N)' : 'Collapse (Alt+Shift+N)';
  }
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
  if (wasCollapsed && !m.collapsed) {
    renderHeader();
    renderList();
  }
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

/* ── expand the collapsed edge tab while dragging external content ─────── */

let dragExpandTimer = null;

function clearDragExpand() {
  clearTimeout(dragExpandTimer);
  dragExpandTimer = null;
  el.tab.classList.remove('is-drag-hover');
}

function draggedContentSupported(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.some((type) => ['Files', 'text/plain', 'text/uri-list', 'text/html'].includes(type));
}

document.addEventListener('dragenter', (event) => {
  if (!el.html.classList.contains('collapsed') || !draggedContentSupported(event)) return;
  event.preventDefault();
  el.tab.classList.add('is-drag-hover');
  if (dragExpandTimer) return;
  dragExpandTimer = setTimeout(() => {
    clearDragExpand();
    api.dock.expand();
  }, 280);
});

document.addEventListener('dragover', (event) => {
  if (!el.html.classList.contains('collapsed') || !draggedContentSupported(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) clearDragExpand();
});

document.addEventListener('drop', clearDragExpand);
document.addEventListener('dragend', clearDragExpand);

/* ── keyboard ────────────────────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  if (!el.noteEditor.hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeNoteEditor();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (!el.pop.hidden) return closeWhen();
    if (!el.catPop.hidden) return closeCat();
    if (!el.sheet.hidden) return closeSheet();
    if (aiOpen()) return closeAiPane();
    if (editingId) return;
    return api.dock.collapse();
  }
  if (e.ctrlKey && ['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault();
    setView({ 1: 'schedule', 2: 'notes', 3: 'tasks', 4: 'links' }[e.key]);
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

api.reminders.onFired((entries) => {
  for (const entry of entries || []) {
    const item = find(entry.id);
    if (!item) continue;
    item.notified = true;
    item.notifiedAt = entry.notifiedAt;
  }
});

setInterval(() => {
  if (dockCollapsed || aiOpen() || !el.sheet.hidden || !el.noteEditor.hidden) return;
  const today = startOfDay(Date.now());
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
}, 60_000);

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

  data = loaded && Array.isArray(loaded.items) ? loaded : { version: 3, items: [] };
  // Legacy shape from an earlier build.
  if (Array.isArray(loaded?.events) || Array.isArray(loaded?.tasks)) {
    data.items = [
      ...(loaded.events || []).map((i) => ({ ...i, kind: 'event' })),
      ...(loaded.tasks || []).map((i) => ({ ...i, kind: 'task' })),
    ];
  }
  // Links arrived in 1.2 — older data files simply don't have the array.
  if (!Array.isArray(data.links)) data.links = [];
  let migratedData = false;
  data.items = data.items.map((item) => {
    if (item.kind !== 'note') return item;
    const content = typeof item.content === 'string' ? item.content : '';
    const checklist = Array.isArray(item.checklist) ? item.checklist : [];

    // The short-lived 1.3 rich-note build converted every task into a blank
    // note. Recover those rows automatically. Genuine rich notes carry content,
    // checklist items, or noteVersion.
    if (!item.noteVersion && !content.trim() && checklist.length === 0) {
      const { content: _content, checklist: _checklist, updatedAt: _updatedAt, noteVersion: _noteVersion, ...task } = item;
      migratedData = true;
      return { ...task, kind: 'task' };
    }

    const next = {
      ...item,
      noteVersion: 1,
      content,
      checklist,
      updatedAt: item.updatedAt || item.createdAt || Date.now(),
    };
    if (!item.noteVersion || !Array.isArray(item.checklist) || typeof item.content !== 'string') migratedData = true;
    return next;
  });
  if (data.version !== 3) {
    data.version = 3;
    migratedData = true;
  }
  data.items.forEach((i) => seenIds.add(i.id));
  data.links.forEach((l) => seenIds.add(l.id));

  settings = s;
  view = ['notes', 'tasks', 'links'].includes(s.view) ? s.view : 'schedule';
  calMode = s.scheduleMode === 'month' ? 'month' : 'list';
  applyViewChrome();

  applyDock(metrics);
  syncSettingsUi();
  renderSlotUi();
  renderAll();
  refreshComposer();
  if (migratedData) save();

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
