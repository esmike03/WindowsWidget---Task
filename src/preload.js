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
  notify: (payload) => ipcRenderer.send('notify', payload),
  quit: () => ipcRenderer.send('app:quit'),
});
