'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   ChatGPT through the Codex CLI.

   Codex is OpenAI's own local agent. Signed in with a ChatGPT account it runs
   on that subscription, and unlike the chatgpt.com page it can open, search
   and read files on this PC by itself. Sidenote only launches it and relays
   its progress; Codex keeps its own sign-in in %USERPROFILE%\.codex.

   Access is limited by Codex's sandbox:
     read  → `read-only`: it can read files and run read-only commands
     edit  → `workspace-write`: it may also change files inside the folder
   ═══════════════════════════════════════════════════════════════════════ */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_TIMEOUT_MS = 10 * 60_000;
const NPM_NATIVE = path.join(
  'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64',
  'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'
);
const NPM_LAUNCHER = path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js');

function exists(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function pathDirs() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // A packaged app started at login may not see a PATH change made after the
  // user signed in, so also look where npm puts global installs by default.
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  return dirs;
}

/**
 * How to start Codex: `{ cmd, pre, env }`, or null if it isn't installed.
 * The native exe is preferred — it avoids an extra Node process per run.
 */
function locate(override) {
  if (override && exists(override)) {
    if (/\.js$/i.test(override)) return viaLauncher(override);
    return { cmd: override, pre: [], env: {} };
  }
  for (const dir of pathDirs()) {
    const native = path.join(dir, NPM_NATIVE);
    if (exists(native)) {
      return {
        cmd: native,
        pre: [],
        env: {
          CODEX_MANAGED_BY_NPM: '1',
          CODEX_MANAGED_PACKAGE_ROOT: path.join(dir, 'node_modules', '@openai', 'codex'),
        },
      };
    }
    const launcher = path.join(dir, NPM_LAUNCHER);
    if (exists(launcher)) return viaLauncher(launcher);
    const exe = path.join(dir, 'codex.exe');
    if (exists(exe)) return { cmd: exe, pre: [], env: {} };
  }
  return null;
}

/** Runs the npm launcher script with Electron's built-in Node. */
function viaLauncher(script) {
  return { cmd: process.execPath, pre: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Ends Codex and anything it started (its shell commands run as children). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGTERM');
  }
}

/** A short, readable line for the status header while Codex works. */
function describe(item) {
  if (!item) return null;
  if (item.type === 'command_execution') {
    const cmd = String(item.command || '')
      .replace(/^"[^"]*powershell(\.exe)?"\s+-Command\s+/i, '')
      .replace(/^['"]|['"]$/g, '');
    return `Running ${cmd.slice(0, 80)}`;
  }
  if (item.type === 'mcp_tool_call') {
    return item.arguments?.title || `Using ${item.tool || 'a tool'}`;
  }
  if (item.type === 'file_change') return 'Editing files…';
  if (item.type === 'web_search') return 'Searching the web…';
  if (item.type === 'reasoning') return 'Thinking…';
  return null;
}

class Codex {
  /** @param {{ settings: { get: () => object } }} o */
  constructor({ settings }) {
    this.settings = settings;
    this.child = null;
    this.loginChild = null;
    this.threadId = null; // follow-ups continue the same conversation
    this.stopped = false;
  }

  bin() {
    return locate(this.settings.get().codexPath);
  }

  folder() {
    const saved = this.settings.get().askFolder;
    try {
      if (saved && fs.statSync(saved).isDirectory()) return saved;
    } catch (_) {
      /* fall through */
    }
    return os.homedir();
  }

  run(bin, args, { input, timeoutMs = 20_000 } = {}) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let child;
      try {
        child = spawn(bin.cmd, [...bin.pre, ...args], {
          env: { ...process.env, ...bin.env },
          windowsHide: true,
        });
      } catch (e) {
        return resolve({ code: -1, out: '', err: e.message });
      }
      const timer = setTimeout(() => killTree(child), timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => (err += e.message));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  /** { installed, signedIn, method, folder } — shown in Settings and the Ask bar. */
  async status() {
    const bin = this.bin();
    if (!bin) return { installed: false, signedIn: false, folder: this.folder() };
    const res = await this.run(bin, ['login', 'status']);
    const text = `${res.out}\n${res.err}`;
    const signedIn = res.code === 0 && /logged in/i.test(text);
    return {
      installed: true,
      signedIn,
      method: /chatgpt/i.test(text) ? 'chatgpt' : signedIn ? 'api-key' : null,
      folder: this.folder(),
    };
  }

  /** Opens the ChatGPT sign-in page in the browser; resolves when it finishes. */
  async login() {
    const bin = this.bin();
    if (!bin) return { ok: false, error: 'Codex is not installed.' };
    if (this.loginChild) return { ok: false, error: 'A sign-in is already in progress.' };
    const res = await new Promise((resolve) => {
      const child = spawn(bin.cmd, [...bin.pre, 'login'], {
        env: { ...process.env, ...bin.env },
        windowsHide: true,
      });
      this.loginChild = child;
      const timer = setTimeout(() => killTree(child), 5 * 60_000);
      child.on('error', (e) => resolve({ code: -1, err: e.message }));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
    this.loginChild = null;
    const after = await this.status();
    return after.signedIn ? { ok: true, status: after } : { ok: false, error: res.err || 'Sign-in was not completed.', status: after };
  }

  async logout() {
    const bin = this.bin();
    if (!bin) return { ok: false };
    await this.run(bin, ['logout']);
    this.threadId = null;
    return { ok: true, status: await this.status() };
  }

  newChat() {
    this.threadId = null;
  }

  cancel() {
    if (!this.child) return;
    this.stopped = true;
    killTree(this.child);
  }

  /**
   * One question. `onStatus` receives progress lines; resolves with
   * `{ ok, text }` or `{ ok: false, error }`.
   */
  ask({ prompt, imagePath, schemaPath, onStatus }) {
    const bin = this.bin();
    if (!bin) {
      return Promise.resolve({
        ok: false,
        error: 'ChatGPT needs the Codex app. Install it with "npm i -g @openai/codex", then sign in from Settings → ChatGPT.',
        needsSetup: true,
      });
    }
    if (this.child) return Promise.resolve({ ok: false, error: 'ChatGPT is still working on the last question.' });

    const s = this.settings.get();
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s', s.askAccess === 'edit' ? 'workspace-write' : 'read-only',
      '-C', this.folder(),
    ];
    if (s.codexModel) args.push('-m', String(s.codexModel));
    // Fixed reply shape so Sidenote can apply the changes ChatGPT asks for.
    if (schemaPath) args.push('--output-schema', schemaPath);
    if (this.threadId) args.push('resume', this.threadId);
    if (imagePath) args.push('-i', imagePath);
    args.push('-'); // prompt on stdin: no quoting or length limits

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin.cmd, [...bin.pre, ...args], {
          env: { ...process.env, ...bin.env },
          windowsHide: true,
        });
      } catch (e) {
        return resolve({ ok: false, error: `Couldn't start Codex: ${e.message}` });
      }
      this.child = child;

      let buf = '';
      let answer = '';
      let failure = '';
      let stderr = '';
      const timer = setTimeout(() => {
        failure = 'Timed out after 10 minutes.';
        killTree(child);
      }, RUN_TIMEOUT_MS);

      const handle = (line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          return;
        }
        if (ev.type === 'thread.started' && ev.thread_id) this.threadId = ev.thread_id;
        else if (ev.type === 'item.started') {
          const note = describe(ev.item);
          if (note) onStatus?.(note);
        } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
          // Codex narrates as it goes; the last message is the answer.
          answer = String(ev.item.text || '').trim();
          // Structured answers are JSON; only narrate plain progress messages.
          if (answer && !answer.startsWith('{')) onStatus?.(answer.split('\n')[0].slice(0, 90));
        } else if (ev.type === 'turn.failed') {
          failure = ev.error?.message || 'ChatGPT could not finish.';
        } else if (ev.type === 'error' && ev.message) {
          failure = ev.message;
        }
      };

      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(line);
        }
      });
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      child.on('error', (e) => (failure = e.message));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buf.trim()) handle(buf.trim());
        this.child = null;
        if (this.stopped) {
          this.stopped = false;
          return resolve({ ok: false, error: 'Stopped.', stopped: true });
        }
        if (answer && !failure) return resolve({ ok: true, text: answer });
        let error = failure || lastErrorLine(stderr) || `Codex exited with code ${code}.`;
        if (/log ?in|auth|401|unauthori[sz]ed/i.test(error)) {
          error = 'ChatGPT is not signed in. Open Settings → ChatGPT and choose Sign in.';
        }
        resolve({ ok: false, error });
      });

      child.stdin.end(prompt);
    });
  }

  destroy() {
    killTree(this.child);
    killTree(this.loginChild);
  }
}

function lastErrorLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Reading (additional )?(input|prompt) from stdin/i.test(l));
  const err = lines.reverse().find((l) => /error/i.test(l));
  return err ? err.replace(/^\S+Z\s+ERROR\s+\S+:\s*/, '').slice(0, 300) : '';
}

module.exports = { Codex, locate };
