// electron/preload.cjs — safe bridge between the renderer UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  listIdentities: () => ipcRenderer.invoke('db:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  getDomains: () => ipcRenderer.invoke('domains:get'),

  generate: (opts) => ipcRenderer.invoke('generate:run', opts),
  cancelGenerate: () => ipcRenderer.send('generate:cancel'),
  onGenerateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('generate:progress', listener);
    return () => ipcRenderer.removeListener('generate:progress', listener);
  },

  deleteIdentities: (ids) => ipcRenderer.invoke('db:delete', ids),
  openInbox: (id) => ipcRenderer.invoke('inbox:open', id),
  openMessage: (id, mid) => ipcRenderer.invoke('message:open', { id, mid }),
  openBrowser: (id) => ipcRenderer.invoke('browser:open', id),
  exportData: () => ipcRenderer.invoke('data:export'),

  net: {
    status: () => ipcRenderer.invoke('net:status'),
    start: () => ipcRenderer.invoke('net:start'),
    apply: (id) => ipcRenderer.invoke('net:apply', id),
    clear: (id) => ipcRenderer.invoke('net:clear', id),
    transports: () => ipcRenderer.invoke('net:transports'),
  },
});
