// electron/preload.cjs — safe bridge between the renderer UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

// Electron prefixes every error from the main process; the UI shows these to people.
const invoke = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((err) => {
    throw new Error(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  });

contextBridge.exposeInMainWorld('forge', {
  listIdentities: () => invoke('db:list'),
  getSettings: () => invoke('settings:get'),
  saveSettings: (patch) => invoke('settings:save', patch),
  getDomains: () => invoke('domains:get'),
  getHome: () => invoke('home:get'),
  appVersion: () => invoke('app:version'),
  checkUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  onUpdateState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  openHome: () => invoke('home:open'),
  testMail: (patch) => invoke('settings:test', patch),

  generate: (opts) => invoke('generate:run', opts),
  cancelGenerate: () => ipcRenderer.send('generate:cancel'),
  onGenerateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('generate:progress', listener);
    return () => ipcRenderer.removeListener('generate:progress', listener);
  },

  deleteIdentities: (ids) => invoke('db:delete', ids),
  upsertCategory: (cat) => invoke('categories:upsert', cat),
  removeCategory: (id) => invoke('categories:remove', id),
  assignCategory: (ids, categoryId) => invoke('categories:assign', { ids, categoryId }),
  renameIdentity: (id, nickname) => invoke('db:rename', { id, nickname }),
  fetchImage: (url) => invoke('avatar:fetch', url),
  openInbox: (id) => invoke('inbox:open', id),
  openMessage: (id, mid) => invoke('message:open', { id, mid }),
  openBrowser: (id) => invoke('browser:open', id),
  exportData: () => invoke('data:export'),

  macros: {
    list: () => invoke('macros:list'),
    record: (context) => invoke('macros:record', context),
    stopRecording: () => invoke('macros:stop-record'),
    play: (id, speed) => invoke('macros:play', { id, speed }),
    stop: () => invoke('macros:stop'),
    rename: (id, name) => invoke('macros:rename', { id, name }),
    remove: (id) => invoke('macros:delete', id),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('rec:progress', listener);
      return () => ipcRenderer.removeListener('rec:progress', listener);
    },
    onCursor: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('rec:cursor', listener);
      return () => ipcRenderer.removeListener('rec:cursor', listener);
    },
  },

  net: {
    status: () => invoke('net:status'),
    start: () => invoke('net:start'),
    apply: (id) => invoke('net:apply', id),
    clear: (id) => invoke('net:clear', id),
    transports: () => invoke('net:transports'),
  },
});
