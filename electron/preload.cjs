const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
let systemLanguages = [];
try {
  const prefix = '--tixtab-system-languages=';
  const argument =
    typeof process !== 'undefined' && process.argv?.find((s) => s.startsWith(prefix));
  const languages = argument && JSON.parse(argument.slice(prefix.length));
  if (Array.isArray(languages))
    systemLanguages = languages
      .filter((s) => typeof s === 'string' && /^[a-z0-9_-]{1,100}$/i.test(s))
      .slice(0, 32);
} catch {
  /* An unavailable system preference falls back to English in the renderer. */
}
contextBridge.exposeInMainWorld('surfaceDesktop', {
  systemLanguages,
  setUiScale: (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 4)
      return false;
    webFrame.setZoomFactor(value / 2);
    return true;
  },
  penHaptics: {
    run: (action, value) => ipcRenderer.invoke('pen:haptic', action, value),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('pen:haptic-status', listener);
      return () => ipcRenderer.removeListener('pen:haptic-status', listener);
    },
  },
  onNativePen: (callback) => {
    const listener = (_event, sample) => callback(sample);
    ipcRenderer.on('pen:native', listener);
    return () => ipcRenderer.removeListener('pen:native', listener);
  },
  createDesktopShortcut: () => ipcRenderer.invoke('app:desktop-shortcut'),
  openDocumentUrl: (url) => ipcRenderer.invoke('document:open-url', url),
  getPdfFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  revealPdf: (request) => ipcRenderer.invoke('document:reveal-pdf', request),
  editCommand: (command) => ipcRenderer.invoke('edit:command', command),
  editKey: (key, select) => ipcRenderer.invoke('edit:key', key, select),
  openClipboardHistory: () => ipcRenderer.invoke('edit:clipboard-history'),
  clipboardShelf: {
    run: (action, value) => ipcRenderer.invoke('clipboard:shelf', action, value),
    onChanged: (callback) => {
      const listener = (_event, gesture) => callback(gesture === 'send' ? 'send' : 'press');
      ipcRenderer.on('clipboard:shelf-changed', listener);
      return () => ipcRenderer.removeListener('clipboard:shelf-changed', listener);
    },
  },
  imageExport: { run: (request) => ipcRenderer.invoke('images:export', request) },
  batchPdf: { run: (request) => ipcRenderer.invoke('batch:run', request) },
  windowsAiOcr: { run: (request) => ipcRenderer.invoke('ocr:windows-ai', request) },
  nativeOcr: { run: (request) => ipcRenderer.invoke('ocr:native', request) },
  pdfEditor: { run: (request) => ipcRenderer.invoke('pdf-editor:run', request) },
  documentTools: { run: (request) => ipcRenderer.invoke('document:local-tools', request) },
  runtimes: {
    run: (request) => ipcRenderer.invoke('runtimes:run', request),
    onProgress: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('runtimes:progress', listener);
      return () => ipcRenderer.removeListener('runtimes:progress', listener);
    },
  },
  dictation: {
    run: (request) => ipcRenderer.invoke('dictation:run', request),
    onProgress: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('dictation:progress', listener);
      return () => ipcRenderer.removeListener('dictation:progress', listener);
    },
  },
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
  fullscreenState: (active) => ipcRenderer.invoke('window:fullscreen-state', active),
  penTailVoice: {
    configure: (enabled) => ipcRenderer.invoke('pen:tail-voice-configure', enabled),
    onPress: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('pen:tail-voice', listener);
      return () => ipcRenderer.removeListener('pen:tail-voice', listener);
    },
  },
  onFullscreen: (callback) => {
    const listener = (_event, active) => callback(active);
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
  },
});
