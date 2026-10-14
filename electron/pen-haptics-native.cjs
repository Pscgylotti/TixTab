// Windows Runtime ABI, from microsoft/windows-rs Windows.Devices.Input/Haptics.
// Called only on the Electron UI thread, using an actual native pointer ID.
// No polling, extra runtime, global input hook, or per-point IPC is required.
function createNativeHaptics() {
  const k = require('koffi'),
    combase = k.load('combase.dll');
  const init = combase.func('int32 __stdcall RoInitialize(uint32 type)');
  const hr = init(1);
  if (hr < 0 && hr !== -2147417850) throw new Error('WinRT unavailable');
  const uninit = combase.func('void __stdcall RoUninitialize()');
  const createString = combase.func(
    'int32 __stdcall WindowsCreateString(str16 text,uint32 length,void *result)',
  );
  const deleteString = combase.func('int32 __stdcall WindowsDeleteString(void *text)');
  const getFactory = combase.func(
    'int32 __stdcall RoGetActivationFactory(void *name,void *iid,void *result)',
  );
  const signatures = new Map();
  const invoke = (object, slot, result, args, ...values) => {
    const signature = `${result} __stdcall TixTabHapticCall(void *self${args ? ',' + args : ''})`;
    if (!signatures.has(signature))
      signatures.set(
        signature,
        k.proto(signature.replace('TixTabHapticCall', 'TixTabHapticCall' + signatures.size)),
      );
    const table = k.decode(object, 'void *');
    return k.call(
      k.decode(table, slot * k.sizeof('void *'), 'void *'),
      signatures.get(signature),
      object,
      ...values,
    );
  };
  const check = (result) => {
    if (result < 0) throw new Error('Pen haptics unavailable');
  };
  const release = (object) => {
    if (object) invoke(object, 2, 'uint32', '');
  };
  const pointer = (object, slot, args = '', ...values) => {
    const out = Buffer.alloc(k.sizeof('void *'));
    check(invoke(object, slot, 'int32', `${args ? args + ',' : ''}void *result`, ...values, out));
    return k.decode(out, 'void *');
  };
  const guid = (value) => {
    const hex = value.replaceAll('-', ''),
      out = Buffer.alloc(16);
    out.writeUInt32LE(parseInt(hex.slice(0, 8), 16));
    out.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
    out.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
    Buffer.from(hex.slice(16), 'hex').copy(out, 8);
    return out;
  };
  const factory = (name, iid) => {
    const string = Buffer.alloc(k.sizeof('void *')),
      out = Buffer.alloc(k.sizeof('void *'));
    check(createString(name, name.length, string));
    const handle = k.decode(string, 'void *');
    try {
      check(getFactory(handle, guid(iid), out));
      return k.decode(out, 'void *');
    } finally {
      deleteString(handle);
    }
  };
  let penFactory,
    waves,
    controller,
    feedbacks = [],
    disposed = false,
    intensity = false;
  const stop = () => {
    if (controller) {
      try {
        check(invoke(controller, 12, 'int32', ''));
      } catch {}
    }
  };
  const clear = () => {
    stop();
    feedbacks.forEach((f) => release(f.object));
    feedbacks = [];
    release(controller);
    controller = null;
  };
  try {
    penFactory = factory('Windows.Devices.Input.PenDevice', '9dfbbe01-0966-5180-bcb4-b85060e39479');
    waves = factory(
      'Windows.Devices.Haptics.KnownSimpleHapticsControllerWaveforms',
      'a7d24c27-b79d-510a-bf79-ff6d49173e1d',
    );
  } catch (error) {
    release(penFactory);
    if (hr >= 0) uninit();
    throw error;
  }
  const waveform = (slot) => {
    const out = Buffer.alloc(2);
    check(invoke(waves, slot, 'int32', 'void *result', out));
    return out.readUInt16LE();
  };
  let codes;
  try {
    codes = {
      pen: waveform(12),
      ballpoint: waveform(12),
      pencil: waveform(14),
      highlighter: waveform(7),
      eraser: waveform(8),
    };
  } catch (error) {
    release(waves);
    release(penFactory);
    if (hr >= 0) uninit();
    throw error;
  }
  return {
    detect(id) {
      if (disposed) return false;
      clear();
      let pen, pen2, vector;
      try {
        pen = pointer(penFactory, 6, 'uint32 id', id);
        if (!pen) return false;
        pen2 = pointer(pen, 0, 'void *iid', guid('0207d327-7fb8-5566-8c34-f8342037b7f9'));
        controller = pointer(pen2, 6);
        if (!controller) return false;
        const supported = Buffer.alloc(1);
        check(invoke(controller, 8, 'int32', 'void *value', supported));
        intensity = !!supported[0];
        vector = pointer(controller, 7);
        const count = Buffer.alloc(4);
        check(invoke(vector, 7, 'int32', 'void *count', count));
        for (let i = 0; i < Math.min(count.readUInt32LE(), 64); i++) {
          const object = pointer(vector, 6, 'uint32 index', i),
            code = Buffer.alloc(2);
          try {
            check(invoke(object, 6, 'int32', 'void *waveform', code));
            feedbacks.push({ object, code: code.readUInt16LE() });
          } catch (error) {
            release(object);
            throw error;
          }
        }
        return feedbacks.some((f) => f.code === codes.pen);
      } catch {
        clear();
        return false;
      } finally {
        release(vector);
        release(pen2);
        release(pen);
      }
    },
    start(tool, strength = 0.5) {
      if (!controller || disposed) return false;
      const feedback =
        feedbacks.find((f) => f.code === codes[tool]) ??
        feedbacks.find((f) => f.code === codes.pen);
      if (!feedback) return false;
      stop();
      if (strength <= 0) return true;
      if (intensity)
        check(
          invoke(
            controller,
            14,
            'int32',
            'void *feedback,double intensity',
            feedback.object,
            Math.min(1, Math.max(0, strength)),
          ),
        );
      else check(invoke(controller, 13, 'int32', 'void *feedback', feedback.object));
      return true;
    },
    stop,
    clear,
    dispose() {
      if (disposed) return;
      clear();
      release(waves);
      release(penFactory);
      disposed = true;
      if (hr >= 0) uninit();
    },
  };
}
module.exports = { createNativeHaptics };
