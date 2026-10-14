import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { openClipboardHistory } = createRequire(import.meta.url)(
  '../electron/clipboard-history.cjs',
);
it('sends only the fixed Win+V shortcut and releases modifiers after partial injection', () => {
  const send = vi.fn((count, buffer, size) => {
    expect(size).toBe(40);
    const keys = Array.from({ length: count }, (_, i) => [
      buffer.readUInt16LE(i * size + 8),
      buffer.readUInt32LE(i * size + 12),
    ]);
    expect(keys).toEqual(
      count === 4
        ? [
            [91, 0],
            [86, 0],
            [86, 2],
            [91, 2],
          ]
        : [
            [86, 2],
            [91, 2],
          ],
    );
    return count === 4 ? 1 : count;
  });
  expect(openClipboardHistory({ platform: 'win32', arch: 'x64', send })).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
  expect(openClipboardHistory({ platform: 'linux', send })).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
  expect(openClipboardHistory({ platform: 'win32', arch: 'x64', send: () => 4 })).toBe(true);
});
