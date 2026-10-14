import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ created: 0, released: 0, recognize: vi.fn() }));
vi.mock('./modelLibrary', () => ({ requireLocalModels: vi.fn(async () => {}) }));
vi.mock('./cacheAccess', () => ({ withModelCacheUse: async (work: () => Promise<any>) => work() }));
vi.mock('./nativeResources', () => ({ releaseNativeModel: vi.fn(async () => {}) }));
vi.mock('./ocrWorkerSession', () => ({
  releaseOcr: vi.fn(),
  createOcrSession: () => {
    mocks.created++;
    return { localOcr: mocks.recognize, releaseOcr: () => mocks.released++ };
  },
}));
import { withBitmapOcrPool } from './providers';
function image(w: number, h: number) {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return 'data:image/png;base64,' + b.toString('base64');
}
afterEach(() => {
  mocks.created = mocks.released = 0;
  vi.clearAllMocks();
});
it('reuses one warm owner for large pages even as four decode lanes alternate', async () => {
  mocks.recognize.mockResolvedValue({ text: 'words' });
  await withBitmapOcrPool(4, new AbortController().signal, async (run) => {
    for (let i = 0; i < 12; i++) await run(image(2000, 2000), i % 4);
  });
  expect(mocks.created).toBe(1);
  expect(mocks.released).toBe(1);
});
it('allows four small inputs and releases every owner', async () => {
  mocks.recognize.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { text: 'words' };
  });
  await withBitmapOcrPool(4, new AbortController().signal, (run) =>
    Promise.all(Array.from({ length: 4 }, (_, i) => run(image(1000, 1000), i))),
  );
  expect(mocks.created).toBe(4);
  expect(mocks.released).toBe(4);
});
it('an early consumer error cannot leave queued recognition alive after the scan closes', async () => {
  mocks.recognize.mockRejectedValue(new Error('failed'));
  await expect(
    withBitmapOcrPool(4, new AbortController().signal, (run) =>
      Promise.all(Array.from({ length: 4 }, (_, i) => run(image(2000, 2000), i))),
    ),
  ).rejects.toThrow('failed');
  const created = mocks.created;
  await new Promise((r) => setTimeout(r, 5));
  expect(mocks.created).toBe(created);
  expect(mocks.released).toBe(created);
});
