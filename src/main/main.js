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
  session,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { Store } = require('./store');
const { Dock, COLLAPSED_W, COLLAPSED_H } = require('./dock');
const { Ask } = require('./ask');
const { resolveTools, resolveToolUrl, toolOrigins, isHttpUrl } = require('./tools');

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
  autoCollapse: true, // tuck back to the edge as soon as focus leaves
  alwaysOnTop: true,
  reminders: true,
  startWithWindows: true, // the widget is meant to be there when you log in
  view: 'schedule', // schedule | notes
  aiOpen: false,
  aiTab: 'chatgpt', // chatgpt | claude | custom | mail
  paneCustom: { label: 'Gmail', url: 'https://mail.google.com/mail/u/0/' },
  paneMail: 'outlook', // id from MAIL_PROVIDERS
  askTarget: 'chatgpt', // which site the floating Ask bar drives
  askBounds: null, // remembered position of the Ask bar
  toolUrls: {}, // per-tool URL overrides, keyed by tool id
};

// The two chat tabs are fixed; the remaining two are user-configurable slots.
// The `ai*` naming here (and in the IPC channels and settings keys) predates
// them and is kept so existing settings.json files and sessions keep working.
const AI_FIXED = {
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  claude: { label: 'Claude', url: 'https://claude.ai/new' },
};

// Offered in the mail slot's picker. Any of these can also be typed into the
// custom slot by hand.
const MAIL_PROVIDERS = [
  { id: 'outlook', label: 'Outlook', url: 'https://outlook.live.com/mail/0/' },
  { id: 'gmail', label: 'Gmail', url: 'https://mail.google.com/mail/u/0/' },
  { id: 'yahoo', label: 'Yahoo Mail', url: 'https://mail.yahoo.com/' },
  { id: 'proton', label: 'Proton Mail', url: 'https://mail.proton.me/u/0/' },
  { id: 'icloud', label: 'iCloud Mail', url: 'https://www.icloud.com/mail/' },
  { id: 'zoho', label: 'Zoho Mail', url: 'https://mail.zoho.com/zm/' },
  { id: 'fastmail', label: 'Fastmail', url: 'https://app.fastmail.com/mail/' },
  { id: 'gmx', label: 'GMX', url: 'https://www.gmx.com/' },
  { id: 'aol', label: 'AOL Mail', url: 'https://mail.aol.com/' },
];

const DEFAULT_CUSTOM_SLOT = { label: 'Gmail', url: 'https://mail.google.com/mail/u/0/' };

/** The four pane tabs with both configurable slots resolved. */
function paneSites() {
  const s = settings.get();

  const custom = s.paneCustom && isHttpUrl(s.paneCustom.url) ? s.paneCustom : DEFAULT_CUSTOM_SLOT;
  const provider =
    MAIL_PROVIDERS.find((p) => p.id === s.paneMail) || MAIL_PROVIDERS[0];

  return {
    ...AI_FIXED,
    custom: { label: String(custom.label || 'Custom').slice(0, 18), url: custom.url },
    mail: { label: provider.label, url: provider.url },
  };
}

/** Origins any pane webview may attach to: fixed sites, both slots, all tools. */
function paneOrigins() {
  const out = toolOrigins(settings.get().toolUrls);
  for (const site of Object.values(paneSites())) {
    try {
      out.add(new URL(site.url).origin);
    } catch (_) {
      /* skip */
    }
  }
  return out;
}
// Changing this string would orphan every session the user has already signed in.
const AI_PARTITION = 'persist:sidenote-ai';

const DEFAULT_DATA = { version: 1, items: [], links: [] };

let win = null;
let tray = null;
let dock = null;
let ask = null;
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
      webviewTag: true, // the ChatGPT / Claude panes
    },
  });

  hardenWebviews(win.webContents);

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
    const s = settings.get();
    // Never auto-collapse out from under the AI pane: a sign-in popup or the
    // chat site itself taking focus would otherwise hide the panel mid-use.
    if (s.autoCollapse && !s.collapsed && !s.aiOpen) dock.setCollapsed(true);
  });

  // Never let the widget navigate away or spawn browser windows in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---------------------------------------------------------------------------
// Embedded AI browser (ChatGPT / Claude)
// ---------------------------------------------------------------------------

/** Electron's default UA advertises Electron, which some sign-in flows reject. */
function chromeUserAgent() {
  const major = String(process.versions.chrome || '120').split('.')[0];
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
}

function setupAiSession() {
  session.fromPartition(AI_PARTITION).setUserAgent(chromeUserAgent());
}

/**
 * The AI panes are <webview>s. Lock them down at attach time and make sure a
 * webview can never be created with anything other than our own partition.
 */
function hardenWebviews(hostContents) {
  hostContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;

    // Allowed origins are the four fixed sites plus wherever the tool
    // launcher currently points — the user configures those, so they are
    // resolved fresh on every attach rather than captured at startup.
    let origin = null;
    try {
      origin = new URL(params.src).origin;
    } catch (_) {
      origin = null;
    }
    const allowed = !!origin && paneOrigins().has(origin);
    if (params.partition !== AI_PARTITION || !allowed) event.preventDefault();
  });
}

/**
 * Sign-in flows (Google, Apple, magic links) open popups. Denying them would
 * make logging in impossible, so give them a real window on the same session.
 */
function handleAiPopups(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https:/i.test(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 700,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        webPreferences: {
          partition: AI_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });
}

/**
 * Google refuses OAuth inside embedded browser frameworks, so the pane can't
 * complete a "Sign in with Google" flow. Popping the site out into a real
 * Chrome/Edge app window sidesteps it entirely: it's a genuine browser, it
 * uses the user's normal profile (so they're usually already signed in), and
 * `--app=` means it still has no address bar or tab strip.
 */
function appModeBrowsers() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return [
    path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter((p) => p && fs.existsSync(p));
}

function popOutSite(key) {
  const site = paneSites()[key];
  if (!site) return false;

  const exe = appModeBrowsers()[0];
  if (exe) {
    try {
      spawn(exe, [`--app=${site.url}`], { detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch (err) {
      console.error('[sidenote] app-mode launch failed', err);
    }
  }
  shell.openExternal(site.url); // fall back to the default browser
  return true;
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
  const payload = {
    source,
    resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  };
  if (win && !win.isDestroyed()) win.webContents.send('theme:changed', payload);
  if (ask && ask.win && !ask.win.isDestroyed()) ask.win.webContents.send('theme:changed', payload);
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
        label: 'Ask about this screen…\tAlt+Shift+A',
        click: () => ask.show(),
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
      globalShortcut.register(accel, () => {
        try {
          fn();
        } catch (err) {
          console.error(`[sidenote] shortcut ${accel} failed`, err);
        }
      });
    } catch (_) {
      /* accelerator taken by another app — not fatal */
    }
    if (process.env.SIDENOTE_DEBUG) {
      console.log(`[sidenote] shortcut ${accel}: ${globalShortcut.isRegistered(accel) ? 'ok' : 'TAKEN'}`);
    }
  };
  bind('Alt+Shift+N', () => (settings.get().collapsed ? expandAndFocus() : dock.setCollapsed(true)));
  bind('Alt+Shift+M', () => {
    dock.cycleDisplay();
    refreshTrayMenu();
  });
  bind('Alt+Shift+A', () => ask.toggle());
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

  // Saved links open in the user's real browser, never inside the widget.
  ipcMain.handle('link:open', (_e, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      shell.openExternal(u.href);
      return true;
    } catch (_) {
      return false;
    }
  });

  ipcMain.handle('tools:list', () => resolveTools(settings.get().toolUrls));

  /** An empty or invalid URL clears the override and restores the default. */
  ipcMain.handle('tools:setUrl', (_e, id, url) => {
    const next = { ...(settings.get().toolUrls || {}) };
    const clean = String(url || '').trim();
    if (!clean) delete next[id];
    else if (isHttpUrl(clean)) next[id] = clean;
    else if (isHttpUrl(`https://${clean}`)) next[id] = `https://${clean}`;
    else return { ok: false, error: 'That is not a valid web address.' };

    settingsStore.set({ toolUrls: next });
    return { ok: true, tools: resolveTools(next) };
  });

  ipcMain.handle('tools:url', (_e, id) => resolveToolUrl(id, settings.get().toolUrls));

  ipcMain.handle('ai:sites', () => paneSites());
  ipcMain.handle('ai:providers', () => MAIL_PROVIDERS);

  /** The free-form slot: any label, any http(s) address. */
  ipcMain.handle('ai:setCustom', (_e, payload) => {
    const label = String(payload?.label || '').trim().slice(0, 18);
    let url = String(payload?.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!isHttpUrl(url)) return { ok: false, error: 'That is not a valid web address.' };

    settingsStore.set({ paneCustom: { label: label || new URL(url).hostname, url } });
    return { ok: true, sites: paneSites() };
  });

  /** The mail slot: pick one of the known providers. */
  ipcMain.handle('ai:setMail', (_e, id) => {
    if (!MAIL_PROVIDERS.some((p) => p.id === id)) return { ok: false, error: 'Unknown mail provider.' };
    settingsStore.set({ paneMail: id });
    return { ok: true, sites: paneSites() };
  });
  ipcMain.on('ai:open', (_e, open) => dock.setAiOpen(!!open));
  ipcMain.on('ai:tab', (_e, tab) => {
    if (paneSites()[tab]) settingsStore.set({ aiTab: tab });
  });
  ipcMain.handle('ai:popout', (_e, tab) => popOutSite(tab));

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
    ask?.destroy();
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
    // Always start on the notes panel; don't load a chat site at login.
    settingsStore.set({ aiOpen: false });

    // 1.2 had fixed Gmail/Outlook tabs; they are configurable slots now.
    const legacyTab = { gmail: 'custom', outlook: 'mail' }[settingsStore.get().aiTab];
    if (legacyTab) settingsStore.set({ aiTab: legacyTab });

    setupAiSession();
    app.on('web-contents-created', (_e, contents) => {
      if (contents.getType() === 'webview') handleAiPopups(contents);
    });

    registerIpc();
    createWindow();

    ask = new Ask({
      root: ROOT,
      settings,
      mainWindow: () => win,
      harden: hardenWebviews,
      sites: paneSites,
    });
    ask.registerIpc();

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
