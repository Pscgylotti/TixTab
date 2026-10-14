import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const { createClipboardShelf, attachClipboardNotifications } = createRequire(import.meta.url)(
  '../electron/clipboard-shelf.cjs',
);
const shelves: any[] = [];
afterEach(() => shelves.splice(0).forEach((s) => s.dispose()));
function fixture() {
  let serial = 1,
    content: Record<string, Blob> = { 'text/plain': new Blob(['first']) };
  const read = vi.fn(async () => [
    { types: Object.keys(content), getType: async (type: string) => content[type] },
  ]);
  const changed = vi.fn(),
    nativeImage = { createFromBuffer: vi.fn() };
  const shelf = createClipboardShelf({
    clipboard: { read },
    nativeImage,
    sequence: () => serial,
    changed,
  });
  shelves.push(shelf);
  return {
    shelf,
    read,
    changed,
    nativeImage,
    set(data: Record<string, Blob>) {
      content = data;
      serial++;
    },
  };
}
it('captures only changed clipboard versions; deduplicates, deletes and releases history', async () => {
  const { shelf, read, set } = fixture();
  await shelf.capture();
  await shelf.capture();
  expect(read).toHaveBeenCalledTimes(1);
  set({ 'text/plain': new Blob(['second']) });
  await shelf.capture();
  set({ 'text/plain': new Blob(['first']) });
  await shelf.capture();
  expect(shelf.list().entries.map((e: any) => e.text)).toEqual(['first', 'second']);
  const id = shelf.list().entries[0].id;
  expect(shelf.get(id).text).toBe('first');
  shelf.remove(id);
  expect(shelf.get(id)).toBeNull();
  shelf.clear();
  await shelf.capture();
  expect(shelf.list()).toMatchObject({ entries: [], bytes: 0 });
});
it('has no count cap, pages summaries and trims 128 MiB to 32 MiB in low memory mode', async () => {
  const { shelf, set } = fixture();
  await shelf.capture();
  for (let i = 0; i < 85; i++) {
    set({ 'text/plain': new Blob([`text ${i}`]) });
    await shelf.capture();
  }
  expect(shelf.list()).toMatchObject({ total: 86, limit: 128 * 1024 * 1024 });
  expect(shelf.list().entries).toHaveLength(40);
  expect(shelf.list(80).entries).toHaveLength(6);
  for (let i = 0; i < 6; i++) {
    set({
      'text/html': new Blob([`<span data-tixtab-objects="${'x'.repeat(4_000_000)}${i}"></span>`]),
    });
    await shelf.capture();
  }
  expect(shelf.list().bytes).toBeGreaterThan(32 * 1024 * 1024);
  shelf.memory(true);
  expect(shelf.list()).toMatchObject({ limit: 32 * 1024 * 1024 });
  expect(shelf.list().bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  const count = shelf.list().entries.length;
  const text = vi.fn();
  set({ 'text/plain': { size: 129 * 1024 * 1024, text } as unknown as Blob });
  await shelf.capture();
  set({ 'text/plain': new Blob(['TixTab page 12345678-1234-1234-1234-123456789abc']) });
  await shelf.capture();
  expect(shelf.list().entries).toHaveLength(count);
  expect(text).not.toHaveBeenCalled();
  shelf.memory(false);
  expect(shelf.list().limit).toBe(128 * 1024 * 1024);
});
it('preserves editable object HTML and creates a bounded ink preview', async () => {
  const { shelf, set } = fixture();
  await shelf.capture();
  const raw = JSON.stringify({
    strokes: [
      {
        color: '#ff0000',
        size: 2,
        points: [
          [1, 2, 0.5],
          [3, 4, 1],
        ],
      },
    ],
  }).replaceAll('"', '&quot;');
  const html = `<span data-tixtab-ink="${raw}">[TixTab ink]</span>`;
  set({ 'text/plain': new Blob(['[TixTab ink]']), 'text/html': new Blob([html]) });
  await shelf.capture();
  const entry = shelf.list().entries[0];
  expect(entry).toMatchObject({ kind: 'ink', count: 1 });
  expect(entry.preview).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(shelf.get(entry.id).html).toBe(html);
});
it('rejects compressed PNG bombs before decoding and discards pending reads after pause, clear or disposal', async () => {
  const { shelf, set, nativeImage } = fixture();
  await shelf.capture();
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(30000, 16);
  png.writeUInt32BE(30000, 20);
  set({ 'image/png': new Blob([png]) });
  await shelf.capture();
  expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
  shelf.pause(true);
  set({ 'text/plain': new Blob(['paused']) });
  await shelf.capture();
  expect(shelf.list().entries.some((entry: any) => entry.text === 'paused')).toBe(false);
  shelf.pause(false);
  await shelf.capture();
  expect(shelf.list().entries[0].text).toBe('paused');
  for (const action of ['clear', 'dispose', 'pause']) {
    let release!: () => void;
    const s = createClipboardShelf({
      clipboard: {
        read: () =>
          new Promise((resolve) => {
            release = () =>
              resolve([{ types: ['text/plain'], getType: async () => new Blob(['late']) }]);
          }),
      },
      sequence: () => 1,
    });
    shelves.push(s);
    const pending = s.capture();
    s[action](true);
    release();
    await pending;
    expect(s.list().entries).toHaveLength(0);
  }
});
it('captures Windows clipboard notifications and detaches the native listener exactly once', () => {
  const add = vi.fn(() => 1),
    remove = vi.fn(),
    capture = vi.fn();
  let callback!: () => void, closed!: () => void;
  const win = {
    getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]),
    hookWindowMessage: vi.fn((id, fn) => {
      expect(id).toBe(0x031d);
      callback = fn;
    }),
    unhookWindowMessage: vi.fn(),
    isDestroyed: () => false,
    once: (_event: string, fn: () => void) => {
      closed = fn;
    },
  };
  const dispose = attachClipboardNotifications(win, capture, {
    func: (name: string) => (name.includes('Add') ? add : remove),
  });
  callback();
  expect(capture).toHaveBeenCalledOnce();
  closed();
  dispose();
  expect(remove).toHaveBeenCalledOnce();
  expect(add).toHaveBeenCalledWith(42n);
  expect(win.unhookWindowMessage).toHaveBeenCalledWith(0x031d);
});
