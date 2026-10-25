'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Open a URL in the browser the user used last.

   Windows' "default browser" isn't always the one people actually use, so
   pages such as the ChatGPT sign-in open in the browser whose window sits
   highest in the window stack, i.e. the one most recently in front. If no
   browser is open, the default browser is used.
   ═══════════════════════════════════════════════════════════════════════ */

const { shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const BROWSERS = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe',
  'arc.exe', 'zen.exe', 'librewolf.exe', 'waterfox.exe', 'thorium.exe', 'chromium.exe',
  'floorp.exe', 'yandex.exe', 'iexplore.exe',
]);

let win32 = null;

function api() {
  if (win32 !== null) return win32;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const EnumProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');
    win32 = {
      koffi,
      EnumProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
      OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
    };
  } catch (_) {
    win32 = false;
  }
  return win32;
}

function exePath(w, pid) {
  const h = w.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
  if (!h) return null;
  try {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    if (!w.QueryFullProcessImageNameW(h, 0, buf, size)) return null;
    return String.fromCharCode(...buf.subarray(0, size[0]));
  } finally {
    w.CloseHandle(h);
  }
}

/** Full path of the browser whose window is front-most, or null. */
function lastUsedBrowser() {
  if (process.platform !== 'win32') return null;
  const w = api();
  if (!w) return null;
  const seen = new Map(); // pid -> exe path
  let found = null;
  try {
    // EnumWindows walks top-level windows from the top of the stack down.
    w.EnumWindows((hwnd) => {
      if (!w.IsWindowVisible(hwnd) || w.GetWindowTextLengthW(hwnd) === 0) return true;
      const pidOut = [0];
      w.GetWindowThreadProcessId(hwnd, pidOut);
      const pid = pidOut[0];
      if (!seen.has(pid)) seen.set(pid, exePath(w, pid));
      const exe = seen.get(pid);
      if (exe && BROWSERS.has(path.basename(exe).toLowerCase())) {
        found = exe;
        return false; // stop
      }
      return true;
    }, 0);
  } catch (_) {
    return null;
  }
  return found;
}

/** Opens `url` in the last-used browser, falling back to the default one. */
function openInLastBrowser(url) {
  const exe = lastUsedBrowser();
  if (exe) {
    try {
      spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
      return path.basename(exe, '.exe');
    } catch (_) {
      /* fall through */
    }
  }
  shell.openExternal(url);
  return null;
}

module.exports = { openInLastBrowser, lastUsedBrowser };
