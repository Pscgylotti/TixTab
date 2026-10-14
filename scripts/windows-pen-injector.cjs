// Test-only Windows synthetic pen, targeting the isolated TixTab window.
// No hooks, drivers, background polling or persistent device changes.
module.exports = function createInjector() {
  const k = require('koffi'),
    u = k.load('user32.dll');
  const point = k.struct('TixTabTestPoint', { x: 'int32', y: 'int32' });
  const rect = k.struct('TixTabTestRect', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32',
  });
  const info = k.struct('TixTabTestPointerInfo', {
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
  const pen = k.struct('TixTabTestPenInfo', {
    pointerInfo: info,
    penFlags: 'uint32',
    penMask: 'uint32',
    pressure: 'uint32',
    rotation: 'uint32',
    tiltX: 'int32',
    tiltY: 'int32',
  });
  const touch = k.struct('TixTabTestTouchInfo', {
    pointerInfo: info,
    touchFlags: 'uint32',
    touchMask: 'uint32',
    rcContact: rect,
    rcContactRaw: rect,
    orientation: 'uint32',
    pressure: 'uint32',
  });
  const union = k.union('TixTabTestPointerUnion', { penInfo: pen, touchInfo: touch });
  const type = k.struct('TixTabTestPointerType', { type: 'uint32', data: union });
  const create = u.func(
      'void * __stdcall CreateSyntheticPointerDevice(uint32 type,uint32 count,uint32 mode)',
    ),
    inject = u.func(
      'int __stdcall InjectSyntheticPointerInput(void *device,const void *info,uint32 count)',
    ),
    destroy = u.func('void __stdcall DestroySyntheticPointerDevice(void *device)'),
    last = k.load('kernel32.dll').func('uint32 __stdcall GetLastError()');
  const device = create(3, 1, 3);
  const windowAt = u.func('void * __stdcall WindowFromPoint(TixTabTestPoint point)'),
    className = u.func('int __stdcall GetClassNameW(void *window,void *name,int size)'),
    thread = u.func('uint32 __stdcall GetWindowThreadProcessId(void *window,void *pid)');
  if (!device) throw Error('CreateSyntheticPointerDevice ' + last());
  const buffer = Buffer.alloc(k.sizeof(type)),
    offset = k.offsetof(type, 'data'),
    position = offset + k.offsetof(info, 'ptPixelLocation'),
    flags = offset + k.offsetof(pen, 'penFlags');
  return {
    inspect(x, y) {
      const hwnd = windowAt({ x: Math.round(x), y: Math.round(y) }),
        name = Buffer.alloc(256),
        pid = Buffer.alloc(4);
      className(hwnd, name, 128);
      return {
        className: name.toString('utf16le').replace(/\0.*$/s, ''),
        thread: thread(hwnd, pid),
        pid: pid.readUInt32LE(0),
      };
    },
    send(x, y, barrel, phase = 'hover') {
      buffer.fill(0);
      buffer.writeUInt32LE(3, 0);
      buffer.writeUInt32LE(3, offset);
      buffer.writeUInt32LE(1, offset + 4);
      const pointerFlags =
        phase === 'down'
          ? 2 | 4 | 0x20 | 0x10000
          : phase === 'up'
            ? 2 | 0x40000
            : phase === 'out'
              ? 0x20000
              : 2 | 0x20000;
      buffer.writeUInt32LE(pointerFlags, offset + 12);
      buffer.writeInt32LE(Math.round(x), position);
      buffer.writeInt32LE(Math.round(y), position + 4);
      buffer.writeUInt32LE(barrel ? 1 : 0, flags);
      buffer.writeUInt32LE(1, flags + 4);
      buffer.writeUInt32LE(phase === 'down' ? 600 : 0, flags + 8);
      if (!inject(device, buffer, 1)) throw Error('InjectSyntheticPointerInput ' + last());
    },
    destroy: () => destroy(device),
  };
};
