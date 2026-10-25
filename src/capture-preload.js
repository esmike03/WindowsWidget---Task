'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('captureApi', {
  add: (payload) => ipcRenderer.invoke('capture:add', payload),
  resize: (height) => ipcRenderer.send('capture:resize', height),
  hide: () => ipcRenderer.send('capture:hide'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
  },
  onFocus: (fn) => on('capture:focus', fn),
  onLayout: (fn) => on('capture:layout', fn),
  onTheme: (fn) => on('theme:changed', fn),
});
