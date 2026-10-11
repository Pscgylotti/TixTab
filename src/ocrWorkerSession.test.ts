import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./modelLibrary', () => ({ requireLocalModels: vi.fn(async () => {}) }));
import { localOcr, releaseOcr } from './ocr';
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
  await localOcr(image, vi.fn());
  await localOcr(image, vi.fn());
  expect(FakeWorker.instances).toHaveLength(1);
  expect(FakeWorker.instances[0].messages.map((p) => p.action)).toEqual([
    'load',
    'loadLanguage',
    'initialize',
    'recognize',
    'recognize',
  ]);
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
