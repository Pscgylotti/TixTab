/** Consume only F20 while this foreground app has explicitly enabled tail voice. */
function tailKey(state, message, vk, foreground, emit) {
  if (vk !== 0x83) return false;
  if (message === 0x101 || message === 0x105) {
    const consumed = state.down;
    state.down = false;
    return consumed;
  }
  if (message !== 0x100 && message !== 0x104) return false;
  if (state.down) return true;
  if (!foreground) return false;
  state.down = true;
  emit();
  return true;
}
let hookPrototype;
function createPenTailVoice(onPress) {
  let stop = null;
  return {
    configure(enabled) {
      if (!enabled) {
        stop?.();
        stop = null;
        return { ok: true, enabled: false };
      }
      if (stop) return { ok: true, enabled: true };
      if (process.platform !== 'win32') return { ok: false, error: 'unsupported' };
      try {
        const k = require('koffi'),
          user = k.load('user32.dll'),
          kernel = k.load('kernel32.dll');
        const getForeground = user.func('void * __stdcall GetForegroundWindow()');
        const getPid = user.func(
          'uint32 __stdcall GetWindowThreadProcessId(void *window, void *pid)',
        );
        const callNext = user.func(
          'intptr_t __stdcall CallNextHookEx(void *hook, int32 code, uintptr_t message, void *data)',
        );
        const setHook = user.func(
          'void * __stdcall SetWindowsHookExW(int32 type, void *callback, void *module, uint32 thread)',
        );
        const unhook = user.func('int32 __stdcall UnhookWindowsHookEx(void *hook)');
        const getModule = kernel.func('void * __stdcall GetModuleHandleW(str16 name)');
        const keyState = user.func('int16 __stdcall GetAsyncKeyState(int32 key)');
        const sendInput = user.func(
          'uint32 __stdcall SendInput(uint32 count, void *inputs, int32 size)',
        );
        const proto = (hookPrototype ??= k.proto(
          'intptr_t __stdcall TixTabTailHook(int32 code, uintptr_t message, void *data)',
        ));
        const state = { down: false },
          pid = Buffer.alloc(4);
        const callback = k.register((code, message, data) => {
          if (code >= 0 && data) {
            const vk = k.decode(data, 'uint32');
            if (vk === 0x83) {
              getPid(getForeground(), pid);
              if (
                tailKey(state, Number(message), vk, pid.readUInt32LE(0) === process.pid, () => {
                  // Mark the Win chord as used without changing any modifier's state.
                  if ((keyState(0x5b) | keyState(0x5c)) & 0x8000) {
                    const inputs = Buffer.alloc(80);
                    inputs.writeUInt32LE(1, 0);
                    inputs.writeUInt16LE(0xe8, 8);
                    inputs.writeUInt32LE(1, 40);
                    inputs.writeUInt16LE(0xe8, 48);
                    inputs.writeUInt32LE(2, 52);
                    sendInput(2, inputs, 40);
                  }
                  setImmediate(onPress);
                })
              )
                return 1;
            }
          }
          return callNext(null, code, message, data);
        }, k.pointer(proto));
        const hook = setHook(13, callback, getModule(null), 0);
        if (!hook) {
          k.unregister(callback);
          return { ok: false, error: 'hook-unavailable' };
        }
        stop = () => {
          if (unhook(hook)) k.unregister(callback);
        };
        return { ok: true, enabled: true };
      } catch {
        return { ok: false, error: 'hook-unavailable' };
      }
    },
    dispose() {
      stop?.();
      stop = null;
    },
  };
}
module.exports = { createPenTailVoice, tailKey };
