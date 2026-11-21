const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  sources: () => ipcRenderer.invoke('capture:sources'),
  clock: () => ipcRenderer.invoke('capture:clock'),
  start: sourceId => ipcRenderer.invoke('capture:start', sourceId),
  frame: frame => ipcRenderer.invoke('capture:frame', frame),
  stop: sessionId => ipcRenderer.invoke('capture:stop', sessionId),
  export: sessionId => ipcRenderer.invoke('capture:export', sessionId),
  onInterrupt: callback => { ipcRenderer.on('capture:interrupted', (_event, message) => callback(message)); }
});
