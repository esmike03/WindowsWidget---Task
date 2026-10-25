'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Read-only file tools for the direct ChatGPT connection.

   With Codex, Codex itself reads files. The direct connection only talks to
   the model, so Sidenote offers three tools instead: list a folder, find
   files, read a text file. All three are confined to the folder chosen in
   Settings (symlinks included) and none can write, delete or run anything.
   ═══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_LIST = 300;
const MAX_FOUND = 80;
const MAX_READ = 60_000; // characters per read
const MAX_SCAN_FILES = 4000;
const MAX_CONTENT_BYTES = 2_000_000; // skip content search in bigger files
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'appdata', '.cache', '__pycache__', 'dist', 'build']);
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|ps1|bat|cmd|ini|cfg|conf|toml|ya?ml|log|sql|env|srt|vtt|tex|rtf)$/i;

const TOOLS = [
  {
    type: 'function',
    name: 'list_files',
    description: 'List files and folders inside the user\'s chosen folder. Paths are relative to that folder; use "." for the folder itself.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'Relative folder path, "." for the root.' } },
    },
  },
  {
    type: 'function',
    name: 'find_files',
    description: 'Find files under the chosen folder whose name contains the text, or (for text files) whose content contains it.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'search_contents'],
      properties: {
        text: { type: 'string', description: 'Case-insensitive text to look for.' },
        search_contents: { type: 'boolean', description: 'Also search inside text files (slower).' },
      },
    },
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a text file inside the chosen folder. Long files come back in parts; pass the returned next_offset to continue.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'offset'],
      properties: {
        path: { type: 'string', description: 'Relative file path.' },
        offset: { type: 'integer', description: 'Character offset to start from; 0 for the beginning.' },
      },
    },
  },
];

class FileTools {
  /** @param {() => string} root  the chosen folder, resolved fresh each call */
  constructor(root) {
    this.root = root;
  }

  /** Absolute path for `rel`, or throws if it would leave the folder. */
  async resolve(rel) {
    const root = await fsp.realpath(this.root());
    const target = path.resolve(root, String(rel || '.'));
    let real = target;
    try {
      real = await fsp.realpath(target);
    } catch (_) {
      /* missing paths are reported by the caller */
    }
    const inside = (p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    if (!inside(target) || !inside(real)) throw new Error('That path is outside the folder ChatGPT may read.');
    return { root, abs: real };
  }

  async run(name, args, onStatus) {
    try {
      if (name === 'list_files') return await this.list(args.path, onStatus);
      if (name === 'find_files') return await this.find(args.text, args.search_contents, onStatus);
      if (name === 'read_file') return await this.read(args.path, args.offset, onStatus);
      return { error: `Unknown tool ${name}` };
    } catch (err) {
      return { error: err.message };
    }
  }

  async list(rel, onStatus) {
    const { root, abs } = await this.resolve(rel);
    onStatus?.(`Looking in ${path.relative(path.dirname(root), abs) || abs}…`);
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const out = [];
    for (const e of entries.slice(0, MAX_LIST)) {
      const item = { name: e.name, type: e.isDirectory() ? 'folder' : 'file' };
      if (!e.isDirectory()) {
        try {
          const st = await fsp.stat(path.join(abs, e.name));
          item.size = st.size;
          item.modified = new Date(st.mtimeMs).toISOString().slice(0, 16);
        } catch (_) {
          /* unreadable entry */
        }
      }
      out.push(item);
    }
    return { folder: path.relative(root, abs) || '.', entries: out, truncated: entries.length > MAX_LIST };
  }

  async find(text, searchContents, onStatus) {
    const needle = String(text || '').toLowerCase().trim();
    if (!needle) return { error: 'Give some text to look for.' };
    const { root } = await this.resolve('.');
    onStatus?.(`Searching for “${text}”…`);
    const found = [];
    const queue = [root];
    let scanned = 0;
    while (queue.length && found.length < MAX_FOUND && scanned < MAX_SCAN_FILES) {
      const dir = queue.shift();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) queue.push(full);
          continue;
        }
        if (!e.isFile()) continue;
        scanned += 1;
        const rel = path.relative(root, full);
        if (e.name.toLowerCase().includes(needle)) {
          found.push({ path: rel, match: 'name' });
        } else if (searchContents && TEXT_EXT.test(e.name)) {
          try {
            const st = await fsp.stat(full);
            if (st.size <= MAX_CONTENT_BYTES) {
              const body = await fsp.readFile(full, 'utf8');
              const at = body.toLowerCase().indexOf(needle);
              if (at >= 0) {
                found.push({ path: rel, match: 'content', excerpt: body.slice(Math.max(0, at - 80), at + 120).replace(/\s+/g, ' ') });
              }
            }
          } catch (_) {
            /* unreadable */
          }
        }
        if (found.length >= MAX_FOUND) break;
      }
    }
    return { results: found, scanned_files: scanned, complete: !queue.length && scanned < MAX_SCAN_FILES };
  }

  async read(rel, offset, onStatus) {
    const { abs } = await this.resolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) return { error: 'That is a folder, not a file.' };
    onStatus?.(`Reading ${path.basename(abs)}…`);
    if (!TEXT_EXT.test(abs) && st.size > 0) {
      // Peek: refuse obvious binaries rather than sending garbage.
      const fd = await fsp.open(abs, 'r');
      const { buffer, bytesRead } = await fd.read(Buffer.alloc(4096), 0, 4096, 0);
      await fd.close();
      if (buffer.subarray(0, bytesRead).includes(0)) {
        return { error: 'That looks like a binary file (image, document or program), which this tool can\'t read as text.' };
      }
    }
    const body = await fsp.readFile(abs, 'utf8');
    const start = Math.max(0, Number(offset) || 0);
    const part = body.slice(start, start + MAX_READ);
    const next = start + part.length;
    return {
      path: rel,
      size_chars: body.length,
      content: part,
      next_offset: next < body.length ? next : null,
    };
  }
}

module.exports = { FileTools, TOOLS, exists: (p) => fs.existsSync(p) };
