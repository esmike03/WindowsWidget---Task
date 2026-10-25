'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   Voice input through Windows voice typing (Win+H).

   Windows' own dictation is accurate, free and already set up on Windows 11,
   and it types straight into whichever text field has focus. Sidenote just
   focuses the Ask bar's input and presses Win+H on the user's behalf.
   Electron can't send OS-level keys itself, so this calls user32 through
   koffi, loaded only the first time voice is used.
   ═══════════════════════════════════════════════════════════════════════ */

const VK_LWIN = 0x5b;
const VK_H = 0x48;
const KEYEVENTF_KEYUP = 0x0002;

let keybd = null;
let loadError = null;

function load() {
  if (keybd || loadError) return keybd;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
  } catch (err) {
    loadError = err;
  }
  return keybd;
}

/** Toggles Windows voice typing for the focused field. Returns true if sent. */
function toggleVoiceTyping() {
  if (process.platform !== 'win32' || !load()) return false;
  keybd(VK_LWIN, 0, 0, 0);
  keybd(VK_H, 0, 0, 0);
  keybd(VK_H, 0, KEYEVENTF_KEYUP, 0);
  keybd(VK_LWIN, 0, KEYEVENTF_KEYUP, 0);
  return true;
}

module.exports = { toggleVoiceTyping };
