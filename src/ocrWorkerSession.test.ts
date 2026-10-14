import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./modelLibrary', () => ({ requireLocalModels: vi.fn(async () => {}) }));
import { localOcr, releaseOcr } from './ocr';
import { createOcrSession } from './ocrWorkerSession';
const image = 'data:image/png;base64,aW1hZ2U=';
class FakeWorker {
  static instances: FakeWorker[] = [];
  static hold = '';
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  messages: any[] = [];
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(packet: any) {
    this.messages.push(packet);
    if (packet.action !== FakeWorker.hold)
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            ...packet,
            status: 'resolve',
            data: packet.action === 'recognize' ? { text: ' TixTab 12345 ', confidence: 98 } : {},
          },
        }),
      );
  }
}
beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  vi.stubGlobal('window', {});
  FakeWorker.instances = [];
  FakeWorker.hold = '';
});
afterEach(() => {
  releaseOcr();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each(['load', 'loadLanguage', 'recognize'])(
  'cancels %s immediately and permits a new worker',
  async (action) => {
    FakeWorker.hold = action;
    const controller = new AbortController(),
      progress = vi.fn();
    const pending = localOcr(image, progress, controller.signal),
      rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.messages.at(-1)?.action).toBe(action));
    const old = FakeWorker.instances[0],
      late = old.onmessage!,
      packet = old.messages.at(-1);
    controller.abort();
    await rejected;
    expect(old.terminate).toHaveBeenCalledOnce();
    FakeWorker.hold = '';
    await expect(localOcr(image, progress)).resolves.toMatchObject({
      text: 'TixTab 12345',
      confidence: 98,
    });
    progress.mockClear();
    late({ data: { ...packet, status: 'progress', data: { progress: 1 } } });
    expect(progress).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(2);
  },
);
it('reuses warm OCR without reinitializing or retaining input data', async () => {
  const progress = vi.fn();
  await localOcr(image, progress);
  expect(progress).toHaveBeenCalledWith('加载本地中英 OCR…');
  progress.mockClear();
  await localOcr(image, progress);
  expect(progress).not.toHaveBeenCalledWith('加载本地中英 OCR…');
  expect(FakeWorker.instances).toHaveLength(1);
  expect(FakeWorker.instances[0].messages.map((p) => p.action)).toEqual([
    'load',
    'loadLanguage',
    'initialize',
    'recognize',
    'recognize',
  ]);
});
it('parallel lanes own independent workers and cancelling one cannot terminate another', async () => {
  const a = createOcrSession(false),
    b = createOcrSession(false),
    abort = new AbortController();
  FakeWorker.hold = 'recognize';
  const first = a.localOcr(image, vi.fn(), abort.signal),
    rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = b.localOcr(image, vi.fn());
  try {
    await vi.waitFor(() =>
      expect(
        FakeWorker.instances.filter((w) => w.messages.at(-1)?.action === 'recognize'),
      ).toHaveLength(2),
    );
    abort.abort();
    await rejected;
    expect(FakeWorker.instances[1].terminate).not.toHaveBeenCalled();
    const worker = FakeWorker.instances[1],
      packet = worker.messages.at(-1);
    worker.onmessage!({
      data: { ...packet, status: 'resolve', data: { text: 'second', confidence: 98 } },
    });
    expect((await second).text).toBe('second');
  } finally {
    a.releaseOcr();
    b.releaseOcr();
  }
});
it('times out a stuck recognition and terminates the actual worker', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  FakeWorker.hold = 'recognize';
  const pending = localOcr(image, vi.fn()),
    rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(180000);
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
