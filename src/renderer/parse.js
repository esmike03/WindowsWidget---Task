'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Shared quick-add parsing.

   The panel composer and the floating quick-capture bar are separate windows
   with separate renderers, but "standup tomorrow 9:30am" has to mean the same
   thing in both. This is the single copy; each loads it as a plain script and
   reads `window.SidenoteParse`.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  const DAY = 86_400_000;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const WEEKDAYS = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };

  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

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

  window.SidenoteParse = { parseWhen, startOfDay, DAY };
})();
