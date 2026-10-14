import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { attachNativePen, createPenReader } = createRequire(import.meta.url)(
  '../electron/pen-native.cjs',
);
function fixture() {
  const hooks = new Map<number, (w: Buffer) => void>();
  const send = vi.fn();
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    getContentBounds: () => ({ x: 100, y: 20 }),
    hookWindowMessage: (id: number, callback: (w: Buffer) => void) => hooks.set(id, callback),
    unhookWindowMessage: (id: number) => hooks.delete(id),
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'surfacetab://app/index.html',
      getZoomFactor: () => 2,
      send,
    },
  });
  const sample = { pointerId: 42, barrel: false, contact: false, inRange: true, x: 400, y: 200 };
  const dispose = attachNativePen(win, {
    platform: 'win32',
    trusted: () => true,
    readPen: () => ({ ...sample }),
    screen: { screenToDipPoint: ({ x, y }: { x: number; y: number }) => ({ x: x / 2, y: y / 2 }) },
  });
  const input = () => {
    const w = Buffer.alloc(8);
    w.writeUInt32LE(42 | (2 << 16));
    hooks.get(0x245)!(w);
  };
  return { win, hooks, send, sample, input, dispose };
}
describe('Windows hover pen bridge', () => {
  it.skipIf(process.platform !== 'win32')(
    'loads the real native ABI and safely rejects an unknown pointer',
    () => {
      expect(createPenReader()(65535)).toBeNull();
    },
  );
  it('uses native barrel flags while ordinary hover message button bits are zero; converts DPI and page zoom', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.input();
    expect(f.send).not.toHaveBeenCalled();
    f.sample.barrel = true;
    f.input();
    expect(f.send).toHaveBeenCalledExactlyOnceWith('pen:native', { ...f.sample, x: 50, y: 40 });
    f.dispose();
    expect(f.hooks.size).toBe(0);
  });
  it('coalesces held movement and immediately delivers release, with no stale timer after blur/disposal', () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.sample.barrel = true;
      f.input();
      for (let i = 0; i < 60; i++) {
        f.sample.x++;
        f.input();
      }
      expect(f.send).toHaveBeenCalledTimes(1);
      f.sample.barrel = false;
      f.input();
      vi.advanceTimersByTime(100);
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(f.send.mock.calls.at(-1)![1].barrel).toBe(false);
      f.sample.barrel = true;
      f.input();
      f.input();
      f.win.emit('blur');
      const count = f.send.mock.calls.length;
      vi.advanceTimersByTime(100);
      expect(f.send).toHaveBeenCalledTimes(count);
    } finally {
      f.dispose();
      vi.useRealTimers();
    }
  });
});
