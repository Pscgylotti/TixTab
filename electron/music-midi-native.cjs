// WinMM calls stay in a worker, including drivers that block while opening/sending.
function createMidiNative() {
  const k = require('koffi');
  const dll = k.load('winmm.dll');
  const count = dll.func('uint32 __stdcall midiOutGetNumDevs()');
  const caps = dll.func(
    'uint32 __stdcall midiOutGetDevCapsW(uintptr_t id, void *caps, uint32 bytes)',
  );
  const open = dll.func(
    'uint32 __stdcall midiOutOpen(void *out, uint32 id, uintptr_t callback, uintptr_t instance, uint32 flags)',
  );
  const send = dll.func('uint32 __stdcall midiOutShortMsg(void *handle, uint32 message)');
  const reset = dll.func('uint32 __stdcall midiOutReset(void *handle)');
  const close = dll.func('uint32 __stdcall midiOutClose(void *handle)');
  let handle = null;
  function list() {
    const devices = [],
      duplicates = new Map();
    for (let index = 0; index < Math.min(count(), 128); index++) {
      // MIDIOUTCAPSW has fixed-width members and is 84 bytes on x86/x64.
      const b = Buffer.alloc(84);
      if (caps(index, b, b.length)) continue;
      const name = b.subarray(8, 72).toString('utf16le').split('\0')[0];
      const key = `${b.readUInt16LE(0)}:${b.readUInt16LE(2)}:${name}`;
      const occurrence = duplicates.get(key) || 0;
      duplicates.set(key, occurrence + 1);
      devices.push({ id: `${key}:${occurrence}`, name, index, software: b.readUInt16LE(72) === 7 });
    }
    return devices;
  }
  function shutdown() {
    if (!handle) return;
    // Reset releases sustained/held notes before the handle is closed.
    reset(handle);
    close(handle);
    handle = null;
  }
  return {
    list,
    open(id) {
      shutdown();
      const device = list().find((d) => d.id === id);
      if (!device) throw Error('device-unavailable');
      const out = Buffer.alloc(k.sizeof('void *'));
      const code = open(out, device.index, 0, 0, 0);
      if (code) throw Error(code === 4 ? 'device-busy' : 'device-unavailable');
      handle = k.decode(out, 'void *');
    },
    send(status, a, b = 0) {
      if (!handle || send(handle, status | (a << 8) | (b << 16))) throw Error('device-unavailable');
    },
    close: shutdown,
  };
}
module.exports = { createMidiNative };
