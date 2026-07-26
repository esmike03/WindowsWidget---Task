'use strict';

const { BrowserWindow, screen, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

// The bar is a separate always-on-top window so it can sit over anything the
// user is looking at, on any monitor, independent of where the panel is docked.
const BAR_W = 380;
const BAR_H = 48;
const WIN_MAX_H = 480;

// Screenshots are pasted into a chat composer, so there is no point sending more
// pixels than the site will keep. This also keeps the base64 blob we hand to
// executeJavaScript to a sane size.
const MAX_CAPTURE_W = 1920;

const CAPTURE_HIDE_MS = 180; // let the compositor drop our own window first

class Ask {
  /**
   * @param {object} o
   * @param {string} o.root            project root
   * @param {object} o.settings        { get, set }
   * @param {() => BrowserWindow} o.mainWindow  the panel, hidden during capture
   * @param {(contents) => void} o.harden       webview lockdown for the host window
   * @param {() => object} o.sites              resolved pane sites, for target URLs
   */
  constructor({ root, settings, mainWindow, harden, sites }) {
    this.root = root;
    this.settings = settings;
    this.mainWindow = mainWindow;
    this.harden = harden;
    this.sites = sites;
    this.win = null;
    this.host = null; // offscreen window that actually drives the chat pages
    this.hostReady = null;
    this.pending = new Map(); // requestId -> { resolve, timer }
    this.seq = 0;
    this.anchor = null; // top-left of the input bar, independent of reply direction
    this.layoutDirection = 'below';
  }

  /* ── offscreen automation host ─────────────────────────────────────── */

  /**
   * A never-shown window sized like a desktop browser. The chat sites need a
   * real viewport to render a composer we can drive; borrowing the panel's
   * webviews meant forcing the panel open on every question.
   */
  ensureHost() {
    if (this.host && !this.host.isDestroyed()) return this.hostReady;

    this.host = new BrowserWindow({
      width: 1120,
      height: 880,
      show: false,
      // Keep painting even though it is never presented, or the guest page
      // never lays out and the composer lookup finds nothing.
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(this.root, 'src', 'askhost-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
        webviewTag: true,
      },
    });

    this.host.setMenu(null);
    if (typeof this.harden === 'function') this.harden(this.host.webContents);
    this.host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.host.on('closed', () => {
      this.host = null;
      this.hostReady = null;
    });

    this.hostReady = new Promise((resolve) => {
      ipcMain.once('askhost:ready', () => resolve());
      setTimeout(resolve, 15_000); // never hang the first question on this
    });

    this.host.loadFile(path.join(this.root, 'src', 'renderer', 'askhost.html'));
    return this.hostReady;
  }

  /* ── window ────────────────────────────────────────────────────────── */

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
      title: 'Sidenote Ask',
      webPreferences: {
        preload: path.join(this.root, 'src', 'ask-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });

    this.win.setMenu(null);
    // 'screen-saver' keeps it above the panel, which is already 'floating'.
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(path.join(this.root, 'src', 'renderer', 'ask.html'));

    this.win.on('moved', () => this.rememberPosition());
    this.win.on('closed', () => {
      this.win = null;
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());

    return this.win;
  }

  /** Last position if it still lands on a connected display, else bottom-centre. */
  startBounds() {
    const saved = this.settings.get().askBounds;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return saved.x >= a.x - 40 && saved.x <= a.x + a.width - 40 && saved.y >= a.y - 20 && saved.y <= a.y + a.height - 20;
      });
      if (onScreen) return { x: Math.round(saved.x), y: Math.round(saved.y) };
    }
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(wa.x + (wa.width - BAR_W) / 2),
      y: Math.round(wa.y + wa.height - 160),
    };
  }

  rememberPosition() {
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.win.getBounds();
    const x = bounds.x;
    const y =
      this.layoutDirection === 'above'
        ? bounds.y + bounds.height - BAR_H
        : bounds.y;
    this.anchor = { x, y };
    this.settings.set({ askBounds: { x, y } });
  }

  show() {
    const win = this.create();
    win.show();
    win.focus();
    win.webContents.send('ask:focus');
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  toggle() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.hide();
    else this.show();
  }

  /**
   * Keep the input bar anchored while the reply bubble grows into whichever
   * side has more room. Near the taskbar that means the bubble opens upward;
   * near the top of a display it opens downward.
   */
  resize(height) {
    if (!this.win || this.win.isDestroyed()) return;
    const desiredH = Math.max(BAR_H, Math.min(WIN_MAX_H, Math.round(height)));
    if (!this.anchor) this.rememberPosition();

    const current = this.anchor || { x: this.win.getBounds().x, y: this.win.getBounds().y };
    const display = screen.getDisplayNearestPoint({
      x: Math.round(current.x + BAR_W / 2),
      y: Math.round(current.y + BAR_H / 2),
    });
    const wa = display.workArea;
    const right = wa.x + wa.width;
    const bottom = wa.y + wa.height;
    const anchorX = Math.max(wa.x, Math.min(right - BAR_W, current.x));
    const anchorY = Math.max(wa.y, Math.min(bottom - BAR_H, current.y));

    const above = Math.max(0, anchorY - wa.y);
    const below = Math.max(0, bottom - (anchorY + BAR_H));
    const hasReply = desiredH > BAR_H;
    const direction = hasReply && above > below ? 'above' : 'below';
    const capacity = direction === 'above' ? above : below;
    const h = hasReply ? Math.min(desiredH, BAR_H + capacity) : BAR_H;
    const y = direction === 'above' ? anchorY - (h - BAR_H) : anchorY;

    this.anchor = { x: anchorX, y: anchorY };
    this.layoutDirection = direction;
    this.win.webContents.send('ask:layout', { direction, height: h });
    this.win.setBounds({ x: anchorX, y, width: BAR_W, height: h }, false);
  }

  /* ── capture ───────────────────────────────────────────────────────── */

  /** The display the bar is sitting on — that is what the user is looking at. */
  currentDisplay() {
    if (this.anchor || (this.win && !this.win.isDestroyed())) {
      const b = this.anchor || this.win.getBounds();
      return screen.getDisplayNearestPoint({
        x: Math.round(b.x + BAR_W / 2),
        y: Math.round(b.y + BAR_H / 2),
      });
    }
    return screen.getPrimaryDisplay();
  }

  async captureCurrentScreen() {
    const display = this.currentDisplay();
    const scale = display.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
      fetchWindowIcons: false,
    });
    if (!sources.length) throw new Error('No screen source available to capture.');

    const source =
      sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];

    let image = source.thumbnail;
    if (image.isEmpty()) throw new Error('The screen capture came back empty.');

    const size = image.getSize();
    if (size.width > MAX_CAPTURE_W) {
      image = image.resize({ width: MAX_CAPTURE_W, quality: 'good' });
    }
    return image.toPNG().toString('base64');
  }

  /* ── bridge to the pane ────────────────────────────────────────────── */

  /** Hands the job to the offscreen host and waits for it to report back. */
  async runInHost(payload, timeoutMs) {
    await this.ensureHost();
    if (!this.host || this.host.isDestroyed()) {
      return { ok: false, error: 'Could not start the automation host.' };
    }
    const id = `ask${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'Timed out waiting for a reply.' });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.host.webContents.send('ask:run', { id, ...payload });
    });
  }

  settle(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(result);
  }

  /** Progress notes from the pane ("uploading", "waiting for a reply"...). */
  relayStatus(text) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('ask:status', text);
  }

  /* ── the whole round trip ──────────────────────────────────────────── */

  async submit({ prompt, target }) {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, error: 'Type a prompt first.' };

    const site = typeof this.sites === 'function' ? this.sites()[target] : null;
    if (!site) return { ok: false, error: `Unknown target "${target}".` };

    let image = null;
    const includeScreenshot = !!this.settings.get().askIncludeScreenshot;

    if (includeScreenshot) {
      const bar = this.win && !this.win.isDestroyed() && this.win.isVisible() ? this.win : null;
      // The panel gets hidden too: asked from an open web pane it would otherwise
      // occupy 520px of the shot, covering whatever the question is about.
      const panel = this.mainWindow();
      const panelWasVisible = panel && !panel.isDestroyed() && panel.isVisible();

      try {
        if (bar) bar.hide();
        if (panelWasVisible) panel.hide();
        if (bar || panelWasVisible) await new Promise((r) => setTimeout(r, CAPTURE_HIDE_MS));
        image = await this.captureCurrentScreen();
      } catch (err) {
        return { ok: false, error: `Couldn't capture the screen: ${err.message}` };
      } finally {
        if (panelWasVisible && panel && !panel.isDestroyed()) panel.showInactive();
        if (bar && !bar.isDestroyed()) bar.showInactive();
      }
    }

    this.relayStatus(includeScreenshot ? 'Sending screenshot and prompt…' : 'Sending prompt…');
    return this.runInHost({ prompt: text, target, image, url: site.url }, 150_000);
  }

  registerIpc() {
    ipcMain.handle('ask:submit', (_e, payload) => this.submit(payload || {}));
    ipcMain.handle('ask:capture', () => this.captureCurrentScreen());
    ipcMain.on('ask:show', () => this.show());
    ipcMain.on('ask:resize', (_e, h) => this.resize(h));
    ipcMain.on('ask:hide', () => this.hide());
    ipcMain.on('ask:result', (_e, msg) => this.settle(msg?.id, msg?.result));
    ipcMain.on('ask:progress', (_e, text) => this.relayStatus(String(text || '')));
  }

  destroy() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    if (this.host && !this.host.isDestroyed()) this.host.destroy();
    this.win = null;
    this.host = null;
  }
}

module.exports = { Ask, BAR_W, BAR_H, WIN_MAX_H };
