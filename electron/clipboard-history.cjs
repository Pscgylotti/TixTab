// Fixed OS shortcut only. Caller must verify a trusted, focused application window.
let sendInput;
function openClipboardHistory({ platform = process.platform, arch = process.arch, send } = {}) {
  if (platform !== 'win32' || !['x64', 'arm64', 'ia32'].includes(arch)) return false;
  const size = arch === 'ia32' ? 28 : 40,
    offset = arch === 'ia32' ? 4 : 8;
  const inputs = (keys) => {
    const buffer = Buffer.alloc(size * keys.length);
    keys.forEach(([key, up], i) => {
      buffer.writeUInt32LE(1, i * size);
      buffer.writeUInt16LE(key, i * size + offset);
      buffer.writeUInt32LE(up ? 2 : 0, i * size + offset + 4);
    });
    return buffer;
  };
  let native;
  try {
    if (!send && !sendInput)
      sendInput = require('koffi')
        .load('user32.dll')
        .func('uint32 __stdcall SendInput(uint32 count, void *inputs, int size)');
    native = send || sendInput;
    if (
      native(
        4,
        inputs([
          [0x5b, false],
          [0x56, false],
          [0x56, true],
          [0x5b, true],
        ]),
        size,
      ) === 4
    )
      return true;
  } catch {
    /* Unsupported session or blocked OS shortcut. */
  }
  // A partial injection must not leave a modifier held down.
  try {
    native?.(
      2,
      inputs([
        [0x56, true],
        [0x5b, true],
      ]),
      size,
    );
  } catch {}
  return false;
}
module.exports = { openClipboardHistory };
