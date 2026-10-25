'use strict';

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

// A one-line composer that appears wherever you are. Deliberately its own
// always-on-top window rather than a mode of the panel: the whole point is that
// jotting something down never costs you the panel opening, the dock animating,
// or your current window losing its place.
const BAR_W = 420;
const BAR_H = 52;
const WIN_MAX_H = 116; // the bar plus its parsed-result hint line

const IDLE_MS = 120_000; // tear the window down once it has sat unused

class Capture {
  /**
   * @param {object} o
   * @param {string} o.root       project root
   * @param {object} o.settings   { get, set }
   * @param {(payload: object) => object} o.onAdd  persists the item, returns a result
   */
  constructor({ root, settings, onAdd }) {
    this.root = root;
    this.settings = settings;
    this.onAdd = onAdd;
    this.win = null;
    this.idleTimer = null;
    this.anchor = null; // top-left of the input bar, independent of hint direction
    this.layoutDirection = 'below';
  }

  create() {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const bounds = this.startBounds();
    this.anchor = { x: bounds.x, y: bounds.y };
    this.layoutDirection = 'below';

    this.win = new BrowserWindow({
      ...bounds,
      width: BAR_W,
      height: BAR_H,
      minWidth: BAR_W,
      maxWidth: BAR_W,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      acceptFirstMouse: true,
      title: 'Sidenote Capture',
      webPreferences: {
        preload: path.join(this.root, 'src', 'capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: true,
        spellcheck: false,
      },
    });

    this.win.setMenu(null);
    // Above the panel ('floating') for the same reason the Ask bar is.
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(path.join(this.root, 'src', 'renderer', 'capture.html'));

    this.win.on('moved', () => this.rememberPosition());
    // Clicking away is the same as pressing Esc — a capture bar you have to
    // dismiss deliberately is worse than one that gets out of the way.
    this.win.on('blur', () => this.hide());
    this.win.on('closed', () => {
      this.win = null;
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());

    return this.win;
  }

  /** Last position if it still lands on a connected display, else top-centre. */
  startBounds() {
    const saved = this.settings.get().captureBounds;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return (
          saved.x >= a.x - 40 &&
          saved.x <= a.x + a.width - 40 &&
          saved.y >= a.y - 20 &&
          saved.y <= a.y + a.height - 20
        );
      });
      if (onScreen) return { x: Math.round(saved.x), y: Math.round(saved.y) };
    }
    // Under the cursor's display, high enough to read without covering much.
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return {
      x: Math.round(wa.x + (wa.width - BAR_W) / 2),
      y: Math.round(wa.y + Math.min(180, wa.height * 0.22)),
    };
  }

  rememberPosition() {
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.win.getBounds();
    const x = bounds.x;
    const y =
      this.layoutDirection === 'above' ? bounds.y + bounds.height - BAR_H : bounds.y;
    this.anchor = { x, y };
    this.settings.set({ captureBounds: { x, y } });
  }

  /** Grow into whichever side of the bar has room, keeping the input put. */
  resize(height) {
    if (!this.win || this.win.isDestroyed()) return;
    const desiredH = Math.max(BAR_H, Math.min(WIN_MAX_H, Math.round(height)));
    if (!this.anchor) this.rememberPosition();

    const current = this.anchor || this.win.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: Math.round(current.x + BAR_W / 2),
      y: Math.round(current.y + BAR_H / 2),
    });
    const wa = display.workArea;
    const bottom = wa.y + wa.height;
    const anchorX = Math.max(wa.x, Math.min(wa.x + wa.width - BAR_W, current.x));
    const anchorY = Math.max(wa.y, Math.min(bottom - BAR_H, current.y));

    const above = Math.max(0, anchorY - wa.y);
    const below = Math.max(0, bottom - (anchorY + BAR_H));
    const hasHint = desiredH > BAR_H;
    const direction = hasHint && above > below ? 'above' : 'below';
    const capacity = direction === 'above' ? above : below;
    const h = hasHint ? Math.min(desiredH, BAR_H + capacity) : BAR_H;
    const y = direction === 'above' ? anchorY - (h - BAR_H) : anchorY;

    this.anchor = { x: anchorX, y: anchorY };
    this.layoutDirection = direction;
    this.win.webContents.send('capture:layout', { direction, height: h });
    this.win.setBounds({ x: anchorX, y, width: BAR_W, height: h }, false);
  }

  show() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const win = this.create();
    // Re-derive the position each time: the cursor may be on another monitor
    // now, and a bar that opens off-screen is worse than no bar.
    if (!win.isVisible()) {
      const bounds = this.startBounds();
      this.anchor = { x: bounds.x, y: bounds.y };
      this.layoutDirection = 'below';
      win.setBounds({ ...bounds, width: BAR_W, height: BAR_H }, false);
    }
    win.show();
    win.focus();
    win.webContents.send('capture:focus');
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isVisible()) this.win.hide();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) this.win.destroy();
    }, IDLE_MS);
  }

  toggle() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.hide();
    else this.show();
  }

  registerIpc() {
    ipcMain.handle('capture:add', async (_e, payload) => {
      try {
        return await this.onAdd(payload || {});
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'Could not save that.' };
      }
    });
    ipcMain.on('capture:show', () => this.show());
    ipcMain.on('capture:resize', (_e, h) => this.resize(h));
    ipcMain.on('capture:hide', () => this.hide());
  }

  destroy() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Capture, BAR_W, BAR_H, WIN_MAX_H };
