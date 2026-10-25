'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   ChatGPT ↔ Sidenote.

   Each question goes to Codex with a compact snapshot of the user's items
   and the current time. Codex answers in a fixed JSON shape (reply text plus
   a list of actions) and Sidenote applies those actions itself. Codex never
   touches data.json directly.

   Nothing is lost permanently: completed and deleted items go to the Archive,
   and each batch of changes can be undone from the Ask bar.
   ═══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 150;
const MAX_LINKS = 60;

// Codex's structured output needs every property listed and required, with
// null standing in for "not used".
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'actions'],
  properties: {
    reply: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'kind', 'id', 'title', 'when', 'content', 'url', 'category'],
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'complete', 'delete'] },
          kind: { type: ['string', 'null'], enum: ['task', 'event', 'note', 'link', null] },
          id: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          when: { type: ['string', 'null'] },
          content: { type: ['string', 'null'] },
          url: { type: ['string', 'null'] },
          category: { type: ['string', 'null'] },
        },
      },
    },
  },
};

function writeSchema(dir) {
  const file = path.join(dir, 'assistant-schema.json');
  try {
    fs.writeFileSync(file, JSON.stringify(SCHEMA));
    return file;
  } catch (_) {
    return null;
  }
}

/* ── context ─────────────────────────────────────────────────────────── */

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local time with weekday and UTC offset, e.g. "Sun 2026-10-25 14:05 (UTC+08:00)". */
function localStamp(ms) {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${day} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function utcOffset() {
  const m = -new Date().getTimezoneOffset();
  const sign = m >= 0 ? '+' : '-';
  return `${sign}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
}

function plain(html) {
  return String(html || '')
    .replace(/<(br|\/div|\/p|\/li)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function snapshot(data) {
  const items = (data.items || []).filter((i) => !i.archived);
  const byKind = (k) => items.filter((i) => i.kind === k);
  const line = (i) => {
    const when = Number.isFinite(i.at) ? ` @ ${localStamp(i.at)}` : '';
    const body = i.kind === 'note' ? ` — ${plain(i.content).slice(0, 120)}` : '';
    const checks = i.kind === 'note' && Array.isArray(i.checklist) && i.checklist.length
      ? ` [checklist: ${i.checklist.map((c) => `${c.done ? 'x' : ' '} ${c.text}`).join('; ').slice(0, 160)}]`
      : '';
    return `- [${i.id}] ${i.title}${when}${body}${checks}`;
  };
  const section = (name, list) =>
    `${name} (${list.length}):\n${list.length ? list.slice(0, MAX_ITEMS).map(line).join('\n') : '(none)'}`;

  const links = (data.links || []).slice(0, MAX_LINKS);
  return [
    section('Events', byKind('event').sort((a, b) => (a.at || 0) - (b.at || 0))),
    section('Tasks', byKind('task')),
    section('Notes', byKind('note')),
    `Links (${(data.links || []).length}):\n${links.length ? links.map((l) => `- [${l.id}] ${l.title} <${l.url}>${l.category ? ` #${l.category}` : ''}`).join('\n') : '(none)'}`,
  ].join('\n\n');
}

function buildPrompt(userPrompt, data) {
  return `${context(data, 'You can also read files on this PC as usual.')}

User request:
${userPrompt}`;
}

/** Everything the model needs to know about Sidenote, minus the question. */
function context(data, filesNote) {
  const now = Date.now();
  return `You are the assistant inside Sidenote, the user's desktop widget for events, tasks, notes and links. ${filesNote}

Current local time: ${localStamp(now)} (UTC${utcOffset()}).

When the user asks you to remember, note, add, schedule, remind, plan, move, rename, finish or remove something, put the changes in "actions":
- add: kind = "event" (has a time; needs "when"), "task" (a to-do; "when" optional), "note" (title + "content"; for a checklist put one "- [ ] item" per line in content), or "link" ("url", optional "title" and "category").
- update: "id" of an existing item or link, plus only the fields to change; leave the rest null.
- complete: "id" of an event or task that is done.
- delete: "id" of an item or link to remove.
Write "when" as local ISO 8601 with the offset, e.g. ${new Date(now).getFullYear()}-01-31T15:00:00${utcOffset()}. Use ids exactly as listed below; never invent ids. Use null for every field you don't need.
If nothing in Sidenote should change, return an empty "actions" list. Put your answer to the user in "reply", short and plain, and say what you changed.

Sidenote right now:
${snapshot(data)}`;
}

/* ── applying actions ────────────────────────────────────────────────── */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function parseWhen(value) {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) && ms > 0 ? ms : undefined; // undefined = unreadable
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text → note HTML + checklist ("- [ ] x" lines become checklist rows). */
function noteBody(text) {
  const checklist = [];
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/.exec(raw);
    if (m) checklist.push({ id: uid(), text: m[2].trim().slice(0, 200), done: m[1] !== ' ' });
    else lines.push(raw);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const content = lines.map((l) => `<div>${l.trim() ? esc(l) : '<br>'}</div>`).join('');
  return { content, checklist };
}

function cleanUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null;
  } catch (_) {
    return null;
  }
}

function cleanCat(raw) {
  const s = String(raw || '').replace(/^#/, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s ? s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : '';
}

function fmtWhen(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return ` — ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Applies Codex's actions to a copy of `data`.
 * Returns { data, applied: string[], skipped: string[], undo } where `undo`
 * reverses exactly these changes on whatever the data looks like later.
 */
function applyActions(actions, input) {
  const data = {
    ...input,
    items: (input.items || []).map((i) => ({ ...i })),
    links: (input.links || []).map((l) => ({ ...l })),
  };
  const applied = [];
  const skipped = [];
  const added = []; // ids
  const before = new Map(); // id -> original object (item or link)
  const removedLinks = [];
  const now = Date.now();

  const remember = (obj) => {
    if (!before.has(obj.id)) before.set(obj.id, { ...obj });
  };

  for (const a of Array.isArray(actions) ? actions.slice(0, 40) : []) {
    const title = a.title ? String(a.title).trim().slice(0, 240) : '';
    const when = parseWhen(a.when);

    if (a.op === 'add') {
      if (a.kind === 'link') {
        const url = cleanUrl(a.url);
        if (!url) {
          skipped.push(`Link "${a.url || title}" — not a usable address`);
          continue;
        }
        const link = { id: uid(), url, title: title || new URL(url).hostname.replace(/^www\./, ''), category: cleanCat(a.category), createdAt: now };
        data.links.push(link);
        added.push(link.id);
        applied.push(`Saved link “${link.title}”${link.category ? ` in ${link.category}` : ''}`);
        continue;
      }
      if (!title) {
        skipped.push('An item without a title');
        continue;
      }
      if (a.kind === 'note') {
        const { content, checklist } = noteBody(a.content);
        const note = {
          id: uid(), kind: 'note', noteVersion: 1, title, content, checklist,
          at: null, done: false, doneAt: null, archived: false, archivedAt: null,
          createdAt: now, updatedAt: now, notified: true,
        };
        data.items.push(note);
        added.push(note.id);
        applied.push(`Added note “${title}”${checklist.length ? ` (${checklist.length} checklist items)` : ''}`);
        continue;
      }
      if (when === undefined) {
        skipped.push(`“${title}” — couldn't read the time "${a.when}"`);
        continue;
      }
      // An "event" with no time can't sit on the schedule; keep it as a task.
      const kind = a.kind === 'event' && when ? 'event' : 'task';
      const item = {
        id: uid(), kind, title, at: when, done: false, archived: false, createdAt: now,
      };
      data.items.push(item);
      added.push(item.id);
      applied.push(`Added ${kind} “${title}”${fmtWhen(when)}`);
      continue;
    }

    const id = a.id ? String(a.id) : '';
    const item = data.items.find((i) => i.id === id);
    const link = item ? null : data.links.find((l) => l.id === id);
    if (!item && !link) {
      skipped.push(`No item with id ${id || '(missing)'}`);
      continue;
    }

    if (a.op === 'update') {
      const target = item || link;
      remember(target);
      const changes = [];
      if (title && title !== target.title) {
        target.title = title;
        changes.push('renamed');
      }
      if (item && a.when != null) {
        if (when === undefined) {
          skipped.push(`“${target.title}” — couldn't read the time "${a.when}"`);
        } else if (when !== item.at) {
          item.at = when;
          item.notified = false; // new time, new reminder
          changes.push(when ? `moved to ${fmtWhen(when).slice(3)}` : 'time cleared');
        }
      }
      if (item && item.kind === 'note' && a.content != null) {
        const { content, checklist } = noteBody(a.content);
        item.content = content;
        if (checklist.length) item.checklist = checklist;
        item.updatedAt = now;
        changes.push('content updated');
      }
      if (link && a.url) {
        const url = cleanUrl(a.url);
        if (url) {
          link.url = url;
          changes.push('address changed');
        }
      }
      if (link && a.category != null) {
        link.category = cleanCat(a.category);
        changes.push(link.category ? `filed under ${link.category}` : 'unsorted');
      }
      if (changes.length) applied.push(`Updated “${target.title}”: ${changes.join(', ')}`);
      continue;
    }

    if (a.op === 'complete' && item) {
      remember(item);
      Object.assign(item, { done: true, doneAt: now, archived: true, archivedAt: now });
      applied.push(`Completed “${item.title}” (moved to Archive)`);
      continue;
    }

    if (a.op === 'delete') {
      if (item) {
        remember(item);
        Object.assign(item, { archived: true, archivedAt: now });
        applied.push(`Removed “${item.title}” (moved to Archive)`);
      } else {
        const index = data.links.indexOf(link);
        removedLinks.push({ ...link });
        data.links.splice(index, 1);
        applied.push(`Removed link “${link.title}”`);
      }
      continue;
    }

    skipped.push(`Unsupported change "${a.op}"`);
  }

  /** Reverses this batch only, leaving anything else the user did since. */
  const undo = (current) => {
    const addedSet = new Set(added);
    const items = (current.items || [])
      .filter((i) => !addedSet.has(i.id))
      .map((i) => (before.has(i.id) ? { ...before.get(i.id) } : i));
    let curLinks = (current.links || [])
      .filter((l) => !addedSet.has(l.id))
      .map((l) => (before.has(l.id) ? { ...before.get(l.id) } : l));
    for (const l of removedLinks) if (!curLinks.some((x) => x.id === l.id)) curLinks.push(l);
    return { ...current, items, links: curLinks };
  };

  return { data, applied, skipped, undo, changed: applied.length > 0 };
}

/** Codex's final message → { reply, actions }; tolerates a plain-text answer. */
function parseAnswer(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  if (start >= 0) {
    try {
      const obj = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
      if (obj && typeof obj.reply === 'string') {
        return { reply: obj.reply.trim(), actions: Array.isArray(obj.actions) ? obj.actions : [] };
      }
    } catch (_) {
      /* not JSON */
    }
  }
  return { reply: raw, actions: [] };
}

module.exports = { buildPrompt, context, applyActions, parseAnswer, writeSchema, SCHEMA };
