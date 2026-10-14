import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ health: vi.fn(), recognize: vi.fn(), release: vi.fn() }));
vi.mock('./nativeTexo', () => ({ connectNativeTexo: mocks.health }));
vi.mock('./modelIdle', () => ({ getModelIdleSeconds: () => 1800 }));
vi.mock('./ocrWorkerSession', () => ({
  createOcrSession: () => ({ localOcr: mocks.recognize, releaseOcr: mocks.release }),
}));
import { withQueuedNpuTesseract } from './nativeTesseract';
const image = 'data:image/png;base64,aW1hZ2U=';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function setup() {
  mocks.health.mockResolvedValue({
    devices: [{ id: 'NPU' }],
    capabilities: ['tesseract-npu-queue-v1', 'tesseract-npu-mixed-v1', 'release-idle'],
  });
  mocks.recognize.mockResolvedValue({
    layoutBlocks: [{ paragraphs: [{ lines: [{ bbox: { x0: 0, y0: 1, x1: 200, y1: 30 } }] }] }],
  });
}
it('sends CPU layout boxes to a strict NPU batch and disposes the worker', async () => {
  setup();
  const fetch = vi.fn(
    async (_url: string, _options: RequestInit) =>
      new Response(
        JSON.stringify({
          device: 'NPU',
          text: 'word',
          lines: [{ text: 'word', polygon: [0, 1, 200, 1, 200, 30, 0, 30] }],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    withQueuedNpuTesseract('best', 4, new AbortController().signal, (run) => run(image, 0)),
  ).resolves.toMatchObject({ text: 'word' });
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
    variant: 'best',
    batch: 4,
    boxes: [[0, 1, 200, 30]],
  });
  expect(mocks.release).toHaveBeenCalledOnce();
});
it('sends mixed mode without loading a second neural recognizer', async () => {
  setup();
  const fetch = vi.fn(
    async (_url: string, _options: RequestInit) =>
      new Response(JSON.stringify({ device: 'NPU', text: '中文 English', lines: [] })),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    withQueuedNpuTesseract('mixed-best', 1, new AbortController().signal, (run) => run(image, 0)),
  ).resolves.toMatchObject({ text: '中文 English' });
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({
    variant: 'mixed-best',
    batch: 1,
  });
  expect(mocks.recognize).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledOnce();
});
it('cancels in-flight HTTP, releases worker and never retries on CPU', async () => {
  setup();
  const abort = new AbortController();
  const fetch = vi.fn(
    async (_url, options) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const pending = withQueuedNpuTesseract('fast', 1, abort.signal, (run) => run(image, 0));
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  abort.abort();
  await rejected;
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(mocks.recognize).toHaveBeenCalledOnce();
});
it('rejects devices that silently fall back and releases failed sessions', async () => {
  setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ device: 'CPU', text: 'word', lines: [] }))),
  );
  await expect(
    withQueuedNpuTesseract('best', 1, new AbortController().signal, (run) => run(image, 0)),
  ).rejects.toThrow('格式');
  expect(mocks.release).toHaveBeenCalledOnce();
});
