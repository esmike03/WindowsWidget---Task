'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  nativeTheme,
  globalShortcut,
  Tray,
  Menu,
  Notification,
  nativeImage,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { Dock, COLLAPSED_W, COLLAPSED_H } = require('./dock');

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const AUTOSTART_FLAG = '--autostart';

const DEFAULT_SETTINGS = {
  edge: 'right',
  anchor: 0.5,
  collapsed: false,
  displayId: null,
  theme: 'system', // system | light | dark
  onComplete: 'archive', // archive | delete
  autoCollapse: false,
  alwaysOnTop: true,
  reminders: true,
  startWithWindows: true, // the widget is meant to be there when you log in
  view: 'schedule', // schedule | notes
};

const DEFAULT_DATA = { version: 1, items: [] };

let win = null;
let tray = null;
let dock = null;
let settingsStore = null;
let dataStore = null;
let quitting = false;
let relayoutTimer = null;

const settings = {
  get: () => settingsStore.get(),
  set: (patch) => settingsStore.set(patch),
};

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const startCollapsed =
    settings.get().collapsed || process.argv.includes(AUTOSTART_FLAG);
  settingsStore.set({ collapsed: startCollapsed });

  win = new BrowserWindow({
    width: COLLAPSED_W,
    height: COLLAPSED_H,
    minWidth: COLLAPSED_W,
    minHeight: COLLAPSED_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false, // we draw our own radii; DWM rounding would clip the flush edge
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    title: 'Sidenote',
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  dock = new Dock(win, settings);

  win.setMenu(null);
  applyAlwaysOnTop();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    dock.layout({ animate: false });
    win.show();
    if (!startCollapsed) win.focus();
    pushTheme();

    if (process.env.SIDENOTE_DEBUG) {
      const d = dock.display();
      console.log('[sidenote] display', d.id, 'scale', d.scaleFactor, 'workArea', d.workArea);
      console.log('[sidenote] bounds', win.getBounds(), 'collapsed', settings.get().collapsed);
    }
  });

  if (process.env.SIDENOTE_DEBUG) {
    win.webContents.on('console-message', (e, level, message) => {
      console.log('[renderer]', e && e.message ? e.message : message);
    });
  }

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      dock.setCollapsed(true);
    }
  });

  win.on('blur', () => {
    if (settings.get().autoCollapse && !settings.get().collapsed) {
      dock.setCollapsed(true);
    }
  });

  // Never let the widget navigate away or spawn browser windows in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function applyAlwaysOnTop() {
  if (!win) return;
  const on = settings.get().alwaysOnTop !== false;
  win.setAlwaysOnTop(on, on ? 'floating' : 'normal');
}

function expandAndFocus() {
  if (!win) return;
  dock.setCollapsed(false);
  win.show();
  win.focus();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function pushTheme() {
  const source = settings.get().theme || 'system';
  nativeTheme.themeSource = source;
  if (win && !win.isDestroyed()) {
    win.webContents.send('theme:changed', {
      source,
      resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    });
  }
}

// ---------------------------------------------------------------------------
// Startup with Windows
// ---------------------------------------------------------------------------

function applyLoginItem(enabled) {
  const args = app.isPackaged
    ? [AUTOSTART_FLAG]
    : [path.resolve(process.argv[1] || ROOT), AUTOSTART_FLAG];
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args,
      name: 'Sidenote',
    });
  } catch (err) {
    console.error('[sidenote] login item failed', err);
  }
}

function loginItemEnabled() {
  try {
    return !!app.getLoginItemSettings({ path: process.execPath }).openAtLogin;
  } catch (_) {
    return !!settings.get().startWithWindows;
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function iconPath(name) {
  const p = path.join(ASSETS, name);
  return fs.existsSync(p) ? p : undefined;
}

function trayImage() {
  const p = iconPath('tray.png') || iconPath('icon.png');
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
}

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Sidenote — notes & schedule');
  tray.on('click', () => (settings.get().collapsed ? expandAndFocus() : dock.setCollapsed(true)));
  refreshTrayMenu();
}

function notifyRenderer() {
  if (win && !win.isDestroyed()) win.webContents.send('settings:changed', settings.get());
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = settings.get();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: s.collapsed ? 'Show panel' : 'Hide panel',
        click: () => (s.collapsed ? expandAndFocus() : dock.setCollapsed(true)),
      },
      {
        label: 'Move to next screen',
        enabled: screen.getAllDisplays().length > 1,
        click: () => {
          dock.cycleDisplay();
          refreshTrayMenu();
        },
      },
      {
        label: 'Dock to',
        submenu: [
          {
            label: 'Left edge',
            type: 'radio',
            checked: s.edge === 'left',
            click: () => dock.setEdge('left'),
          },
          {
            label: 'Right edge',
            type: 'radio',
            checked: s.edge === 'right',
            click: () => dock.setEdge('right'),
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: loginItemEnabled(),
        click: (item) => {
          settingsStore.set({ startWithWindows: item.checked });
          applyLoginItem(item.checked);
          notifyRenderer();
        },
      },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: s.alwaysOnTop !== false,
        click: (item) => {
          settingsStore.set({ alwaysOnTop: item.checked });
          applyAlwaysOnTop();
          notifyRenderer();
          refreshTrayMenu();
        },
      },
      { type: 'separator' },
      { label: 'Quit Sidenote', click: () => quit() },
    ])
  );
}

// ---------------------------------------------------------------------------
// Shortcuts + displays
// ---------------------------------------------------------------------------

function registerShortcuts() {
  const bind = (accel, fn) => {
    try {
      globalShortcut.register(accel, fn);
    } catch (_) {
      /* accelerator taken by another app — not fatal */
    }
  };
  bind('Alt+Shift+N', () => (settings.get().collapsed ? expandAndFocus() : dock.setCollapsed(true)));
  bind('Alt+Shift+M', () => {
    dock.cycleDisplay();
    refreshTrayMenu();
  });
}

function watchDisplays() {
  const relayout = () => {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      // If the stored monitor is gone, Dock falls back to the primary display.
      dock.layout({ animate: false });
      refreshTrayMenu();
    }, 350);
  };
  screen.on('display-added', relayout);
  screen.on('display-removed', relayout);
  screen.on('display-metrics-changed', relayout);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('data:load', () => dataStore.get());
  ipcMain.handle('data:save', (_e, data) => {
    if (data && typeof data === 'object') dataStore.replace(data);
    return true;
  });

  ipcMain.handle('settings:get', () => ({
    ...settings.get(),
    startWithWindows: loginItemEnabled(),
  }));

  ipcMain.handle('settings:set', (_e, incoming) => {
    const patch = incoming && typeof incoming === 'object' ? incoming : {};
    const before = settings.get();
    const next = settingsStore.set(patch);

    if ('theme' in patch) pushTheme();
    if ('alwaysOnTop' in patch) applyAlwaysOnTop();
    if ('startWithWindows' in patch) applyLoginItem(patch.startWithWindows);
    if ('edge' in patch && patch.edge !== before.edge) dock.layout({ animate: true });
    refreshTrayMenu();
    return { ...next, startWithWindows: loginItemEnabled() };
  });

  ipcMain.handle('dock:metrics', () => dock.metrics());
  ipcMain.on('dock:toggle', () => dock.toggle());
  ipcMain.on('dock:collapse', () => dock.setCollapsed(true));
  ipcMain.on('dock:expand', () => expandAndFocus());
  ipcMain.on('dock:cycleDisplay', () => {
    dock.cycleDisplay();
    refreshTrayMenu();
  });
  ipcMain.on('dock:dragStart', () => dock.beginDrag());
  ipcMain.on('dock:dragEnd', () => dock.endDrag(true));

  ipcMain.on('app:quit', () => quit());

  ipcMain.on('notify', (_e, payload) => {
    if (!settings.get().reminders) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: payload?.title || 'Sidenote',
      body: payload?.body || '',
      silent: false,
      icon: iconPath('icon.png'),
    });
    n.on('click', () => expandAndFocus());
    n.show();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function quit() {
  quitting = true;
  try {
    dataStore?.flush();
    settingsStore?.flush();
  } catch (_) {
    /* ignore */
  }
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => expandAndFocus());

  app.setAppUserModelId('com.sidenote.widget');

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    settingsStore = new Store(path.join(userData, 'settings.json'), DEFAULT_SETTINGS);
    dataStore = new Store(path.join(userData, 'data.json'), DEFAULT_DATA);

    if (!settingsStore.get().displayId) {
      settingsStore.set({ displayId: String(screen.getPrimaryDisplay().id) });
    }

    registerIpc();
    createWindow();
    buildTray();
    registerShortcuts();
    watchDisplays();

    // Keep the OS registration in sync with what the UI shows.
    applyLoginItem(settingsStore.get().startWithWindows);

    nativeTheme.on('updated', () => pushTheme());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Tray-resident widget: closing the panel must not end the process.
  });

  app.on('before-quit', () => {
    quitting = true;
    dataStore?.flush();
    settingsStore?.flush();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
