'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('sidenote', {
  data: {
    load: () => ipcRenderer.invoke('data:load'),
    save: (data) => ipcRenderer.invoke('data:save', data),
    // An item saved from the floating quick-capture bar, so the panel's
    // in-memory copy stays in step and its next save doesn't drop it.
    onAdded: (fn) => on('data:added', fn),
    // ChatGPT changed items from the Ask bar; take the store's copy wholesale.
    onReplaced: (fn) => on('data:replaced', fn),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: (fn) => on('settings:changed', fn),
  },
  dock: {
    metrics: () => ipcRenderer.invoke('dock:metrics'),
    toggle: () => ipcRenderer.send('dock:toggle'),
    collapse: () => ipcRenderer.send('dock:collapse'),
    expand: () => ipcRenderer.send('dock:expand'),
    cycleDisplay: () => ipcRenderer.send('dock:cycleDisplay'),
    dragStart: () => ipcRenderer.send('dock:dragStart'),
    dragEnd: () => ipcRenderer.send('dock:dragEnd'),
    onState: (fn) => on('dock:state', fn),
  },
  theme: {
    onChange: (fn) => on('theme:changed', fn),
  },
  // Blurred wallpaper behind the panel (see src/main/backdrop.js).
  backdrop: {
    onChange: (fn) => on('backdrop:changed', fn),
    onMove: (fn) => on('backdrop:moved', fn),
  },
  links: {
    open: (url) => ipcRenderer.invoke('link:open', url),
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    setUrl: (id, url) => ipcRenderer.invoke('tools:setUrl', id, url),
    url: (id) => ipcRenderer.invoke('tools:url', id),
    add: (payload) => ipcRenderer.invoke('tools:add', payload),
    update: (id, payload) => ipcRenderer.invoke('tools:update', id, payload),
    remove: (id) => ipcRenderer.invoke('tools:remove', id),
    favorite: (id, favorite) => ipcRenderer.invoke('tools:favorite', id, favorite),
  },
  web: {
    preconnect: (url) => ipcRenderer.invoke('web:preconnect', url),
  },
  reminders: {
    onFired: (fn) => on('reminders:fired', fn),
  },
  // The panel only summons the Ask bar; the automation itself runs in the
  // offscreen host window (see askhost.js), so the panel is never disturbed.
  ask: {
    show: () => ipcRenderer.send('ask:show'),
  },
  // ChatGPT runs through the Codex CLI on the user's ChatGPT plan.
  codex: {
    status: () => ipcRenderer.invoke('codex:status'),
    login: () => ipcRenderer.invoke('codex:login'),
    logout: () => ipcRenderer.invoke('codex:logout'),
    pickFolder: () => ipcRenderer.invoke('codex:pickFolder'),
    models: () => ipcRenderer.invoke('codex:models'),
    cancelLogin: () => ipcRenderer.send('codex:cancelLogin'),
    openLogin: (url) => ipcRenderer.invoke('codex:openLogin', url),
    onLoginCode: (fn) => on('codex:loginCode', fn),
  },
  // ChatGPT without Codex: "Sign in with ChatGPT" on the user's plan.
  direct: {
    mode: () => ipcRenderer.invoke('chatgpt:mode'),
    status: () => ipcRenderer.invoke('direct:status'),
    signIn: () => ipcRenderer.invoke('direct:signIn'),
    cancelSignIn: () => ipcRenderer.send('direct:cancelSignIn'),
    signOut: () => ipcRenderer.invoke('direct:signOut'),
    models: () => ipcRenderer.invoke('direct:models'),
  },
  ai: {
    sites: () => ipcRenderer.invoke('ai:sites'),
    providers: () => ipcRenderer.invoke('ai:providers'),
    setCustom: (payload) => ipcRenderer.invoke('ai:setCustom', payload),
    setMail: (id) => ipcRenderer.invoke('ai:setMail', id),
    setOpen: (open) => ipcRenderer.send('ai:open', open),
    setTab: (tab) => ipcRenderer.send('ai:tab', tab),
    popOut: (tab) => ipcRenderer.invoke('ai:popout', tab),
  },
  notify: (payload) => ipcRenderer.send('notify', payload),
  quit: () => ipcRenderer.send('app:quit'),
});
