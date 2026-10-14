// Read penFlags in the owning WndProc: hovering WM_POINTERUPDATE deliberately
// has no ordinary button bits. Do not consume, synthesize, or poll input.
let reader;
function createPenReader() {
  if (reader) return reader;
  const k = require('koffi');
  const point = k.struct('TixTabPenPoint', { x: 'int32', y: 'int32' });
  const info = k.struct('TixTabPointerInfo', {
    pointerType: 'uint32',
    pointerId: 'uint32',
    frameId: 'uint32',
    pointerFlags: 'uint32',
    sourceDevice: 'void *',
    hwndTarget: 'void *',
    ptPixelLocation: point,
    ptHimetricLocation: point,
    ptPixelLocationRaw: point,
    ptHimetricLocationRaw: point,
    dwTime: 'uint32',
    historyCount: 'uint32',
    InputData: 'int32',
    dwKeyStates: 'uint32',
    PerformanceCount: 'uint64',
    ButtonChangeType: 'uint32',
  });
  const pen = k.struct('TixTabPointerPenInfo', {
    pointerInfo: info,
    penFlags: 'uint32',
    penMask: 'uint32',
    pressure: 'uint32',
    rotation: 'uint32',
    tiltX: 'int32',
    tiltY: 'int32',
  });
  const buffer = Buffer.alloc(k.sizeof(pen));
  const flagsOffset = k.offsetof(pen, 'penFlags');
  const positionOffset = k.offsetof(info, 'ptPixelLocation');
  const get = k.load('user32.dll').func('int __stdcall GetPointerPenInfo(uint32_t id, void *info)');
  reader = (id) => {
    if (!get(id, buffer) || buffer.readUInt32LE(0) !== 3) return null;
    const flags = buffer.readUInt32LE(12),
      penFlags = buffer.readUInt32LE(flagsOffset);
    return {
      pointerId: buffer.readUInt32LE(4),
      inRange: !!(flags & 2) && !(flags & 0x8000),
      contact: !!(flags & 4),
      barrel: !!(penFlags & 1) && !(penFlags & 6),
      x: buffer.readInt32LE(positionOffset),
      y: buffer.readInt32LE(positionOffset + 4),
    };
  };
  return reader;
}

function attachNativePen(win, { screen, trusted, readPen, platform = process.platform } = {}) {
  if (platform !== 'win32') return () => {};
  let previous = null,
    latest = null,
    timer = null,
    failed = false,
    disposed = false;
  const send = () => {
    timer = null;
    if (!latest || disposed || win.isDestroyed() || win.webContents.isDestroyed()) return;
    if (!trusted(win.webContents.getURL())) return;
    const sample = latest;
    latest = null;
    const dip = screen.screenToDipPoint({ x: sample.x, y: sample.y });
    const content = win.getContentBounds(),
      zoom = win.webContents.getZoomFactor();
    win.webContents.send('pen:native', {
      ...sample,
      x: (dip.x - content.x) / zoom,
      y: (dip.y - content.y) / zoom,
    });
  };
  const reset = () => {
    clearTimeout(timer);
    timer = null;
    if (previous?.barrel) {
      latest = { ...previous, inRange: false, barrel: false, contact: false };
      send();
    }
    previous = latest = null;
  };
  const hooks = [0x245, 0x246, 0x247, 0x249, 0x24a, 0x24c];
  const receive = (message, id) => {
    if (disposed || failed) return;
    if (message === 0x24a || message === 0x24c) {
      if (previous?.pointerId === id) reset();
      return;
    }
    let sample;
    try {
      sample = (readPen || createPenReader())(id);
    } catch {
      failed = true;
      reset();
      return;
    }
    if (!sample) return;
    if (!win.isFocused() || !sample.inRange) {
      reset();
      return;
    }
    // No IPC during ordinary writing/hover. Held movements are coalesced;
    // button/contact edges and release are delivered immediately.
    const changed =
      !previous || previous.barrel !== sample.barrel || previous.contact !== sample.contact;
    const relevant = sample.barrel || previous?.barrel;
    previous = sample;
    if (!relevant) return;
    latest = sample;
    if (changed) {
      clearTimeout(timer);
      send();
    } else if (!timer) timer = setTimeout(send, 16);
  };
  for (const message of hooks)
    win.hookWindowMessage(message, (wParam) => receive(message, wParam.readUInt32LE(0) & 0xffff));
  let detachRenderer = () => {};
  if (!readPen) {
    try {
      detachRenderer = attachRendererPenMessages(win, (message, param) => {
        if (hooks.includes(message)) receive(message, Number(param) & 0xffff);
      });
    } catch {
      /* DOM events remain available on unsupported runtimes. */
    }
  }
  const dispose = () => {
    if (disposed) return;
    reset();
    disposed = true;
    detachRenderer();
    if (!win.isDestroyed()) for (const message of hooks) win.unhookWindowMessage(message);
    win.removeListener('blur', reset);
    win.removeListener('hide', reset);
    win.removeListener('close', dispose);
  };
  win.on('blur', reset);
  win.on('hide', reset);
  win.on('close', dispose);
  return dispose;
}

let rendererBindings;
function attachRendererPenMessages(win, receive, inspect = () => {}) {
  // Chromium sends WM_POINTER* to its content HWND, not BrowserWindow's HWND.
  // Only subclass our own content windows on this exact UI thread. Always forward
  // every message; never use a global hook or inspect another application's input.
  const k = require('koffi');
  if (!rendererBindings) {
    const user = k.load('user32.dll'),
      com = k.load('comctl32.dll');
    const proc = k.proto(
      'intptr_t __stdcall TixTabPenSubclass(void *hwnd,uint32 message,uintptr_t wparam,intptr_t lparam,uintptr_t id,uintptr_t data)',
    );
    const enumerate = k.proto('int __stdcall TixTabPenEnum(void *hwnd,intptr_t data)');
    rendererBindings = {
      proc,
      enumerate,
      set: com.func(
        'int __stdcall SetWindowSubclass(void *hwnd,TixTabPenSubclass *proc,uintptr_t id,uintptr_t data)',
      ),
      remove: com.func(
        'int __stdcall RemoveWindowSubclass(void *hwnd,TixTabPenSubclass *proc,uintptr_t id)',
      ),
      forward: com.func(
        'intptr_t __stdcall DefSubclassProc(void *hwnd,uint32 message,uintptr_t wparam,intptr_t lparam)',
      ),
      children: user.func(
        'int __stdcall EnumChildWindows(void *hwnd,TixTabPenEnum *proc,intptr_t data)',
      ),
      className: user.func('int __stdcall GetClassNameW(void *hwnd,void *name,int size)'),
      thread: user.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd,void *pid)'),
      currentThread: k.load('kernel32.dll').func('uint32 __stdcall GetCurrentThreadId()'),
    };
  }
  const b = rendererBindings,
    windows = new Map(),
    name = Buffer.alloc(256),
    pid = Buffer.alloc(4),
    id = 0x544958;
  let disposed = false,
    scheduled = false;
  const callback = k.register((hwnd, message, wparam, lparam) => {
    try {
      if (!disposed) receive(message, wparam);
      if (message === 0x82) {
        b.remove(hwnd, callback, id);
        windows.delete(k.address(hwnd));
      }
    } catch {
      /* A failed observer must never interrupt Chromium's window procedure. */
    }
    return b.forward(hwnd, message, wparam, lparam);
  }, k.pointer(b.proc));
  const install = () => {
    if (disposed || win.isDestroyed()) return;
    const root = k.decode(win.getNativeWindowHandle(), 'void *'),
      thread = b.currentThread();
    b.children(
      root,
      (hwnd) => {
        name.fill(0);
        b.className(hwnd, name, 128);
        if (name.toString('utf16le').replace(/\0.*$/s, '') !== 'Chrome_RenderWidgetHostHWND')
          return 1;
        inspect({
          stage: 'child',
          thread: b.thread(hwnd, pid),
          current: thread,
          pid: pid.readUInt32LE(0),
          own: process.pid,
        });
        if (b.thread(hwnd, pid) !== thread || pid.readUInt32LE(0) !== process.pid) return 1;
        const address = k.address(hwnd);
        if (!windows.has(address)) {
          const ok = b.set(hwnd, callback, id, 0);
          inspect({ stage: 'subclass', ok });
          if (ok) windows.set(address, hwnd);
        }
        return 1;
      },
      0,
    );
  };
  const created = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        install();
      });
    }
  };
  win.hookWindowMessage(0x210, created);
  win.webContents.on('dom-ready', created);
  created();
  return () => {
    disposed = true;
    if (!win.isDestroyed()) win.unhookWindowMessage(0x210);
    win.webContents.removeListener('dom-ready', created);
    for (const hwnd of windows.values()) b.remove(hwnd, callback, id);
    windows.clear();
    k.unregister(callback);
  };
}
module.exports = { attachNativePen, createPenReader, attachRendererPenMessages };
