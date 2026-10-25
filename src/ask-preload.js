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
  cancel: () => ipcRenderer.send('ask:cancel'),
  newChat: () => ipcRenderer.send('ask:newChat'),
  undo: () => ipcRenderer.invoke('ask:undo'),
  voiceKey: () => ipcRenderer.invoke('ask:voiceKey'),
  onVoice: (fn) => on('ask:voice', fn),
  codexStatus: () => ipcRenderer.invoke('codex:status'),
  codexLogin: () => ipcRenderer.invoke('codex:login'),
  pickFolder: () => ipcRenderer.invoke('codex:pickFolder'),
  onLoginCode: (fn) => on('codex:loginCode', fn),
  chatgptMode: () => ipcRenderer.invoke('chatgpt:mode'),
  directSignIn: () => ipcRenderer.invoke('direct:signIn'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: (fn) => on('settings:changed', fn),
  },
  onFocus: (fn) => on('ask:focus', fn),
  onStatus: (fn) => on('ask:status', fn),
  onLayout: (fn) => on('ask:layout', fn),
  onTheme: (fn) => on('theme:changed', fn),
});
