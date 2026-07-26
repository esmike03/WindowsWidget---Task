'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('ask', {
  submit: (payload) => ipcRenderer.invoke('ask:submit', payload),
  resize: (height) => ipcRenderer.send('ask:resize', height),
  hide: () => ipcRenderer.send('ask:hide'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  onFocus: (fn) => on('ask:focus', fn),
  onStatus: (fn) => on('ask:status', fn),
  onTheme: (fn) => on('theme:changed', fn),
});
