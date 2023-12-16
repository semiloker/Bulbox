// electron/preload.cjs — safe bridge between the renderer UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  listIdentities: () => ipcRenderer.invoke('db:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  getDomains: () => ipcRenderer.invoke('domains:get'),
  getHome: () => ipcRenderer.invoke('home:get'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  openHome: () => ipcRenderer.invoke('home:open'),
  testMail: (patch) => ipcRenderer.invoke('settings:test', patch),

  generate: (opts) => ipcRenderer.invoke('generate:run', opts),
  cancelGenerate: () => ipcRenderer.send('generate:cancel'),
  onGenerateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('generate:progress', listener);
    return () => ipcRenderer.removeListener('generate:progress', listener);
  },

  deleteIdentities: (ids) => ipcRenderer.invoke('db:delete', ids),
  upsertCategory: (cat) => ipcRenderer.invoke('categories:upsert', cat),
  removeCategory: (id) => ipcRenderer.invoke('categories:remove', id),
  assignCategory: (ids, categoryId) => ipcRenderer.invoke('categories:assign', { ids, categoryId }),
  renameIdentity: (id, nickname) => ipcRenderer.invoke('db:rename', { id, nickname }),
  fetchImage: (url) => ipcRenderer.invoke('avatar:fetch', url),
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
