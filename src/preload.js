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
  links: {
    open: (url) => ipcRenderer.invoke('link:open', url),
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    setUrl: (id, url) => ipcRenderer.invoke('tools:setUrl', id, url),
    url: (id) => ipcRenderer.invoke('tools:url', id),
  },
  // The panel only summons the Ask bar; the automation itself runs in the
  // offscreen host window (see askhost.js), so the panel is never disturbed.
  ask: {
    show: () => ipcRenderer.send('ask:show'),
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
