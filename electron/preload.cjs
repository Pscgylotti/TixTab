const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('surfaceDesktop', {
  onNativePen: (callback) => {
    const listener = (_event, sample) => callback(sample);
    ipcRenderer.on('pen:native', listener);
    return () => ipcRenderer.removeListener('pen:native', listener);
  },
  createDesktopShortcut: () => ipcRenderer.invoke('app:desktop-shortcut'),
  openDocumentUrl: (url) => ipcRenderer.invoke('document:open-url', url),
  editCommand: (command) => ipcRenderer.invoke('edit:command', command),
  runtimes: {
    run: (request) => ipcRenderer.invoke('runtimes:run', request),
    onProgress: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('runtimes:progress', listener);
      return () => ipcRenderer.removeListener('runtimes:progress', listener);
    },
  },
  dictation: { run: (request) => ipcRenderer.invoke('dictation:run', request) },
  chatgpt: { run: (request) => ipcRenderer.invoke('chatgpt:run', request) },
  zotero: {
    run: (request) => ipcRenderer.invoke('zotero:run', request),
    cancel: () => ipcRenderer.invoke('zotero:cancel'),
  },
  caches: {
    list: () => ipcRenderer.invoke('caches:list'),
    clear: (id, token) => ipcRenderer.invoke('caches:clear', id, token),
    cancel: () => ipcRenderer.invoke('caches:cancel'),
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    run: (id, action) => ipcRenderer.invoke('models:run', id, action),
    cancel: () => ipcRenderer.invoke('models:cancel'),
    onProgress: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('models:progress', listener);
      return () => ipcRenderer.removeListener('models:progress', listener);
    },
  },
  providerHttp: {
    start: (request) => ipcRenderer.invoke('providers:http-start', request),
    read: (id) => ipcRenderer.invoke('providers:http-read', id),
    cancel: (id) => ipcRenderer.invoke('providers:http-cancel', id),
  },
  loadProviderSettings: (feature) => ipcRenderer.invoke('providers:load', feature),
  saveProviderSettings: (feature, data) => ipcRenderer.invoke('providers:save', feature, data),
  getOnBattery: () => ipcRenderer.invoke('power:battery'),
  getWindowVisible: () => ipcRenderer.invoke('window:visible'),
  onWindowVisibility: (callback) => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on('window:visibility', listener);
    return () => ipcRenderer.removeListener('window:visibility', listener);
  },
  setNight: (night) => ipcRenderer.invoke('theme:night', night),
  onPower: (callback) => {
    const listener = (_event, active) => callback(active);
    ipcRenderer.on('power:changed', listener);
    return () => ipcRenderer.removeListener('power:changed', listener);
  },
  startNativeTexo: () => ipcRenderer.invoke('texo:start-native'),
  toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  onFullscreen: (callback) => {
    const listener = (_event, active) => callback(active);
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
  },
});
