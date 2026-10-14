const {
  app,
  BrowserWindow,
  session,
  protocol,
  net,
  shell,
  ipcMain,
  powerMonitor,
  nativeTheme,
  safeStorage,
  screen,
} = require('electron');
const { attachNativePen } = require('./pen-native.cjs');
const { createProviderVault } = require('./provider-vault.cjs');
const { lowerPriority } = require('./low-priority.cjs');
const { createDesktopShortcut } = require('./desktop-shortcut.cjs');
const { createProviderRelay } = require('./provider-relay.cjs');
const { createModelLibrary } = require('./model-library.cjs');
const { createCacheManager } = require('./cache-manager.cjs');
const { createZotero } = require('./zotero.cjs');
const { createDictation } = require('./dictation.cjs');
const { createNeuralDictation } = require('./neural-dictation.cjs');
const { createRuntimeInstaller } = require('./runtime-installer.cjs');
const { createChatGPT, createCredentialStore } = require('./chatgpt.cjs');
const modelCatalog = require('./model-catalog.json');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
let nativeProcess = null,
  nativeStarting = null;
app.on('before-quit', () => {
  nativeProcess?.kill();
  nativeProcess = null;
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'surfacetab',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
if (process.env.SURFACETAB_PROFILE) app.setPath('userData', process.env.SURFACETAB_PROFILE);
else app.setPath('userData', path.join(app.getPath('appData'), 'surfacetab'));
app.setAppUserModelId('local.surfacetab.app');
app.whenReady().then(() => {
  const root = path.resolve(__dirname, '../dist');
  const appIcon = path.join(root, process.platform === 'win32' ? 'tixtab.ico' : 'tixtab.png');
  const modelRoot = path.join(app.getPath('userData'), 'model-library', 'v1');
  const modelLibrary = createModelLibrary({
    root: modelRoot,
    bundled: path.join(root, 'models'),
    catalog: modelCatalog,
    fetch: (url, options) => net.fetch(url, options),
    notify: (owner, value) => {
      if (!owner.isDestroyed()) owner.send('models:progress', value);
    },
  });
  app.once('before-quit', () => modelLibrary.dispose());
  protocol.handle('surfacetab', async (request) => {
    const url = new URL(request.url);
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (url.hostname !== 'app' || !file.startsWith(root + path.sep))
      return new Response('Not found', { status: 404 });
    const downloaded = url.pathname.startsWith('/models/')
      ? await modelLibrary.resolve(decodeURIComponent(url.pathname.slice(8)))
      : null;
    return net.fetch(pathToFileURL(downloaded || file).toString());
  });
  const trusted = (raw) => {
    try {
      const url = new URL(raw);
      return (
        (url.protocol === 'surfacetab:' && url.host === 'app') ||
        (process.env.SURFACETAB_DEV === '1' && url.origin === 'http://127.0.0.1:5173')
      );
    } catch {
      return false;
    }
  };
  const vault = createProviderVault({
    file: path.join(app.getPath('userData'), 'provider-settings.v1.enc'),
    safeStorage,
  });
  const providerSender = (event) =>
    event.senderFrame === event.sender.mainFrame && trusted(event.senderFrame.url);
  const editWindows = new Set();
  ipcMain.handle('app:desktop-shortcut', (event) =>
    providerSender(event)
      ? createDesktopShortcut({ app, shell })
      : { ok: false, error: 'untrusted' },
  );
  ipcMain.handle('document:open-url', async (event, value) => {
    if (!providerSender(event) || typeof value !== 'string' || value.length > 8192) return false;
    try {
      const url = new URL(value);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
        return false;
      await shell.openExternal(url.href);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('edit:command', (event, command) => {
    if (
      !(
        providerSender(event) ||
        (editWindows.has(event.sender.id) &&
          event.senderFrame === event.sender.mainFrame &&
          event.senderFrame.url === 'about:blank')
      ) ||
      !['selectAll', 'cut', 'copy', 'paste', 'undo', 'redo'].includes(command)
    )
      return false;
    event.sender[command]();
    return true;
  });
  const chatgpt = createChatGPT({
    fetch: (url, options) => net.fetch(url, options),
    shell,
    diagnose: (report) =>
      require('node:fs/promises').writeFile(
        path.join(app.getPath('userData'), 'chatgpt-last-error.json'),
        JSON.stringify(report, null, 2),
        'utf8',
      ),
    store: createCredentialStore({
      file: path.join(app.getPath('userData'), 'chatgpt.v1.enc'),
      safeStorage,
    }),
  });
  const backend = path.join(
    app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..'),
    'backend',
  );
  const runtimeInstaller = createRuntimeInstaller({
    root: path.join(app.getPath('home'), '.surfacetab'),
    backend,
    fetch: (url, options) => net.fetch(url, options),
    notify: (owner, value) => {
      if (!owner.isDestroyed()) owner.send('runtimes:progress', value);
    },
  });
  app.once('before-quit', () => runtimeInstaller.dispose());
  const runtimeOwners = new WeakSet();
  ipcMain.handle('runtimes:run', (event, request) => {
    if (
      !providerSender(event) ||
      !['openvino', 'speech'].includes(request?.id) ||
      !['status', 'install', 'cancel'].includes(request?.action)
    )
      return { ok: false, error: 'invalid' };
    const owner = event.sender;
    if (!runtimeOwners.has(owner)) {
      runtimeOwners.add(owner);
      const cancel = () => runtimeInstaller.cancel(owner);
      owner.once('destroyed', cancel);
      owner.on('render-process-gone', cancel);
      owner.on('did-start-navigation', (_event, details) => {
        if (details.isMainFrame && !details.isSameDocument) cancel();
      });
    }
    if (request.action === 'status')
      return runtimeInstaller.status(request.id).then((data) => ({ ok: true, data }));
    if (request.action === 'cancel') return { ok: runtimeInstaller.cancel(owner) };
    return runtimeInstaller.install(owner, request.id);
  });
  const dictation = createNeuralDictation({
    backend,
    runtimeInstaller,
    runtime: path.join(app.getPath('home'), '.surfacetab/asr-runtime'),
    modelRoot,
    bundled: path.join(root, 'models'),
    models: modelLibrary,
    system: createDictation({
      helper: path.join(
        __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'),
        'dictation.ps1',
      ),
    }),
  });
  app.once('before-quit', () => dictation.dispose());
  const dictationOwners = new WeakSet();
  ipcMain.handle('dictation:run', (event, request) => {
    if (!providerSender(event)) return { ok: false, error: 'invalid' };
    const owner = event.sender;
    if (!dictationOwners.has(owner)) {
      dictationOwners.add(owner);
      const cancel = () => dictation.cancel(owner);
      owner.once('destroyed', cancel);
      owner.on('render-process-gone', cancel);
      owner.on('did-start-navigation', () => cancel());
    }
    return dictation.run(owner, request);
  });
  const chatOwners = new WeakSet();
  app.once('before-quit', () => chatgpt.dispose());
  ipcMain.handle('chatgpt:run', async (event, request) => {
    if (!providerSender(event)) return { ok: false, error: 'invalid' };
    const owner = event.sender;
    if (!chatOwners.has(owner)) {
      chatOwners.add(owner);
      const cancel = () => chatgpt.cancel(owner);
      owner.once('destroyed', cancel);
      owner.on('render-process-gone', cancel);
      owner.on('did-start-navigation', (_event, details) => {
        if (details.isMainFrame && !details.isSameDocument) cancel();
      });
    }
    return chatgpt.run(owner, request);
  });
  const zotero = createZotero({ shell, clipboard: require('electron').clipboard });
  app.once('before-quit', () => zotero.dispose());
  ipcMain.handle('zotero:cancel', (event) =>
    providerSender(event) ? zotero.cancel(event.sender) : false,
  );
  ipcMain.handle('zotero:run', async (event, request) => {
    if (!providerSender(event)) throw new Error('Untrusted Zotero request');
    const owner = event.sender,
      cancel = () => zotero.cancel(owner),
      navigation = (_event, details) => {
        if (details.isMainFrame && !details.isSameDocument) cancel();
      };
    owner.once('destroyed', cancel);
    owner.once('render-process-gone', cancel);
    owner.on('did-start-navigation', navigation);
    try {
      return await zotero.run(owner, request);
    } finally {
      owner.removeListener('destroyed', cancel);
      owner.removeListener('render-process-gone', cancel);
      owner.removeListener('did-start-navigation', navigation);
    }
  });
  const cacheManager = createCacheManager();
  app.once('before-quit', () => cacheManager.dispose());
  const cacheJob = async (event, action, id, token) => {
    if (!providerSender(event)) throw new Error('Untrusted cache request');
    const owner = event.sender,
      cancel = () => cacheManager.cancel(owner),
      navigation = (_event, details) => {
        if (details.isMainFrame && !details.isSameDocument) cancel();
      };
    owner.once('destroyed', cancel);
    owner.once('render-process-gone', cancel);
    owner.on('did-start-navigation', navigation);
    try {
      return await (action === 'list'
        ? cacheManager.list(owner)
        : cacheManager.clear(owner, id, token));
    } finally {
      owner.removeListener('destroyed', cancel);
      owner.removeListener('render-process-gone', cancel);
      owner.removeListener('did-start-navigation', navigation);
    }
  };
  ipcMain.handle('caches:list', (event) => cacheJob(event, 'list'));
  ipcMain.handle('caches:clear', (event, id, token) => cacheJob(event, 'clear', id, token));
  ipcMain.handle('caches:cancel', (event) =>
    providerSender(event) ? cacheManager.cancel(event.sender) : false,
  );
  ipcMain.handle('models:list', (event) => {
    if (!providerSender(event)) throw new Error('Untrusted model request');
    return modelLibrary.list();
  });
  ipcMain.handle('models:cancel', (event) => {
    if (!providerSender(event)) return false;
    return modelLibrary.cancel(event.sender);
  });
  ipcMain.handle('models:run', async (event, id, action) => {
    if (!providerSender(event)) throw new Error('Untrusted model request');
    const owner = event.sender,
      cancel = () => modelLibrary.cancel(owner),
      navigation = (_event, details) => {
        if (details.isMainFrame && !details.isSameDocument) cancel();
      };
    owner.once('destroyed', cancel);
    owner.once('render-process-gone', cancel);
    owner.on('did-start-navigation', navigation);
    try {
      return await modelLibrary.run(owner, id, action);
    } finally {
      owner.removeListener('destroyed', cancel);
      owner.removeListener('render-process-gone', cancel);
      owner.removeListener('did-start-navigation', navigation);
    }
  });
  const relay = createProviderRelay({
    fetch: (url, options) => net.fetch(url, options),
    allowedSender: providerSender,
  });
  ipcMain.handle('providers:http-start', (event, request) => relay.start(event, request));
  ipcMain.handle('providers:http-read', (event, id) => relay.read(event, id));
  ipcMain.handle('providers:http-cancel', (event, id) => relay.cancel(event, id));
  app.once('before-quit', () => relay.dispose());
  ipcMain.handle('providers:load', (event, feature) => {
    if (!providerSender(event)) throw new Error('Untrusted settings request');
    return vault.read(feature);
  });
  ipcMain.handle('providers:save', (event, feature, data) => {
    if (!providerSender(event)) throw new Error('Untrusted settings request');
    return vault.write(feature, data);
  });
  ipcMain.handle('power:battery', (event) =>
    trusted(event.sender.getURL()) ? powerMonitor.isOnBatteryPower() : false,
  );
  ipcMain.handle('window:visible', (event) => {
    const win = trusted(event.sender.getURL()) && BrowserWindow.fromWebContents(event.sender);
    return !!win && win.isVisible() && !win.isMinimized();
  });
  ipcMain.handle('theme:night', (event, night) => {
    if (trusted(event.sender.getURL())) nativeTheme.themeSource = night === true ? 'dark' : 'light';
  });
  const broadcastPower = (value) => {
    for (const win of BrowserWindow.getAllWindows())
      if (trusted(win.webContents.getURL())) win.webContents.send('power:changed', value);
  };
  powerMonitor.on('on-battery', () => broadcastPower(true));
  powerMonitor.on('on-ac', () => broadcastPower(false));
  ipcMain.handle('texo:start-native', async (event) => {
    if (!trusted(event.sender.getURL())) throw new Error('Untrusted native service request');
    if (nativeStarting) return nativeStarting;
    nativeStarting = (async () => {
      const python = path.join(
        app.getPath('home'),
        '.surfacetab/openvino-runtime/Scripts/python.exe',
      );
      const backend = path.join(
        app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..'),
        'backend',
      );
      if (!existsSync(python) || !existsSync(path.join(backend, 'openvino_app.py')))
        return { available: false };
      if (!nativeProcess) {
        nativeProcess = spawn(
          python,
          [
            '-m',
            'uvicorn',
            'openvino_app:app',
            '--app-dir',
            backend,
            '--host',
            '127.0.0.1',
            '--port',
            '8766',
            '--no-access-log',
          ],
          {
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, SURFACETAB_MANAGED_MODELS: modelRoot },
          },
        );
        const child = nativeProcess;
        lowerPriority(child);
        child.on('error', () => {
          if (nativeProcess === child) nativeProcess = null;
        });
        child.on('exit', () => {
          if (nativeProcess === child) nativeProcess = null;
        });
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const response = await fetch('http://127.0.0.1:8766/health', {
            signal: AbortSignal.timeout(500),
          });
          const data = await response.json();
          if (response.ok && data.engine === 'Texo OpenVINO') return { available: true };
        } catch {}
        if (!nativeProcess) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return { available: false };
    })();
    try {
      return await nativeStarting;
    } finally {
      nativeStarting = null;
    }
  });
  ipcMain.handle('window:fullscreen', (event) => {
    if (!trusted(event.sender.getURL())) return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    const active = !window.isFullScreen();
    window.setFullScreen(active);
    return active;
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
    callback(
      ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission) &&
        trusted(wc.getURL()),
    ),
  );
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) =>
      ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission) &&
      !!wc &&
      trusted(wc.getURL()),
  );
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 560,
    minHeight: 600,
    show: false,
    title: 'TixTab',
    icon: appIcon,
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  attachNativePen(win, { screen, trusted });
  const visibility = () =>
    win.webContents.send('window:visibility', win.isVisible() && !win.isMinimized());
  for (const event of ['hide', 'show', 'minimize', 'restore']) win.on(event, visibility);
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen-changed', false));
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.key === 'F11' || (input.key === 'Escape' && win.isFullScreen()))
    ) {
      event.preventDefault();
      win.setFullScreen(input.key === 'F11' ? !win.isFullScreen() : false);
    }
  });
  let chatWindow = null;
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (
      url === 'about:blank' &&
      frameName === 'surfacetab-chat-floating' &&
      (!chatWindow || chatWindow.isDestroyed())
    ) {
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          parent: win,
          width: 480,
          height: 780,
          minWidth: 340,
          minHeight: 460,
          title: 'TixTab · ChatGPT',
          icon: appIcon,
          autoHideMenuBar: true,
          backgroundMaterial: 'mica',
          webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    try {
      if (
        ['https://translate.google.com'].includes(new URL(url).origin) ||
        url === 'https://github.com/Pscgylotti/TixTab' ||
        modelCatalog.models.some((m) => m.source === url)
      )
        void shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    if (details.frameName !== 'surfacetab-chat-floating') return;
    chatWindow = child;
    editWindows.add(child.webContents.id);
    const editWindowId = child.webContents.id;
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    child.once('closed', () => {
      editWindows.delete(editWindowId);
      chatWindow = null;
    });
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('surfacetab://app/') && !url.startsWith('http://127.0.0.1:5173'))
      event.preventDefault();
  });
  if (process.env.SURFACETAB_DEV === '1') win.loadURL('http://127.0.0.1:5173');
  else win.loadURL('surfacetab://app/index.html');
});
app.on('window-all-closed', () => app.quit());
