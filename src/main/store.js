'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON store with debounced, atomic writes.
 *
 * Atomicity matters here because the widget is killed by the OS at shutdown
 * without warning; a half-written data.json would lose every note.
 */
class Store {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.data = this._read();
    this._timer = null;
  }

  _read() {
    try {
      // Strip a UTF-8 BOM: Notepad and PowerShell both add one when a user
      // hand-edits these files, and JSON.parse chokes on it.
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return Object.assign({}, this.fallback, parsed);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy of whatever we could not parse instead of overwriting it.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch (_) {
          /* best effort */
        }
      }
    }
    return JSON.parse(JSON.stringify(this.fallback));
  }

  get() {
    return this.data;
  }

  set(next) {
    this.data = Object.assign({}, this.data, next);
    this.schedule();
    return this.data;
  }

  replace(next) {
    this.data = next;
    this.schedule();
    return this.data;
  }

  schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[sidenote] failed to persist', this.file, err);
    }
  }
}

module.exports = { Store };
