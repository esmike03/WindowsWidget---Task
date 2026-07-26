'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Deliberately tiny: this window only drives chat pages, it has no UI.
contextBridge.exposeInMainWorld('askHost', {
  ready: () => ipcRenderer.send('askhost:ready'),
  onRun: (fn) => ipcRenderer.on('ask:run', (_e, payload) => fn(payload)),
  result: (id, result) => ipcRenderer.send('ask:result', { id, result }),
  progress: (text) => ipcRenderer.send('ask:progress', text),
});
