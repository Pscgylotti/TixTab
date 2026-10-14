import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { createPenHaptics } = createRequire(import.meta.url)('../electron/pen-haptics.cjs');
it('is opt-in, uses native IDs, stops on release/blur and disposes its controller', () => {
  const native = {
    detect: vi.fn(() => true),
    start: vi.fn(() => true),
    stop: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  };
  const create = vi.fn(() => native),
    owner = createPenHaptics({ platform: 'win32', create });
  owner.sample({ pointerId: 81, contact: false, inRange: true });
  owner.start('pen');
  expect(create).not.toHaveBeenCalled();
  expect(owner.configure(true)).toBe('waiting');
  expect(native.detect).not.toHaveBeenCalled();
  owner.sample({ pointerId: 81, contact: true, inRange: true });
  expect(native.detect).toHaveBeenCalledWith(81);
  owner.start('pencil');
  expect(native.start).toHaveBeenCalledWith('pencil', 0.5);
  owner.sample({ pointerId: 81, contact: false, inRange: true });
  expect(native.stop).toHaveBeenCalled();
  owner.reset();
  owner.start('pen');
  expect(native.start).toHaveBeenCalledOnce();
  owner.dispose();
  expect(native.dispose).toHaveBeenCalledOnce();
});
it('unsupported devices do not vibrate and can be disabled without loading native code', () => {
  const create = vi.fn(),
    owner = createPenHaptics({ platform: 'linux', create });
  expect(owner.configure(true)).toBe('unavailable');
  owner.sample({ pointerId: 1, contact: true, inRange: true });
  owner.start('pen');
  owner.configure(false);
  owner.dispose();
  expect(create).not.toHaveBeenCalled();
});
