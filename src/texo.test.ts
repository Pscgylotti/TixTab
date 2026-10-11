import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./modelLibrary', () => ({ requireLocalModels: vi.fn() }));
import { requireLocalModels } from './modelLibrary';
import { recognizeTexo, releaseTexo } from './texo';
class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    MockWorker.instances.push(this);
  }
}
beforeEach(() => {
  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  MockWorker.instances = [];
  vi.mocked(requireLocalModels).mockReset().mockResolvedValue();
});
afterEach(() => {
  releaseTexo();
  vi.unstubAllGlobals();
});
it('does not create a worker when cancelled during model preflight', async () => {
  let ready!: () => void;
  vi.mocked(requireLocalModels).mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const controller = new AbortController(),
    pending = recognizeTexo('image', 'wasm', vi.fn(), controller.signal);
  controller.abort();
  ready();
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(MockWorker.instances).toHaveLength(0);
});
it('terminates cancelled work, ignores late messages and allows another request', async () => {
  const controller = new AbortController(),
    progress = vi.fn();
  const pending = recognizeTexo('image', 'wasm', progress, controller.signal);
  await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(1));
  const first = MockWorker.instances[0],
    late = first.onmessage!;
  controller.abort();
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(first.terminate).toHaveBeenCalledOnce();
  const next = recognizeTexo('image', 'wasm', progress);
  await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
  late({ data: { type: 'progress', text: 'stale' } });
  late({ data: { type: 'result', latex: 'stale' } });
  expect(progress).not.toHaveBeenCalled();
  MockWorker.instances[1].onmessage!({
    data: { type: 'result', latex: 'x', elapsed: 12, device: 'wasm' },
  });
  await expect(next).resolves.toMatchObject({ latex: 'x' });
  expect(MockWorker.instances[1].terminate).not.toHaveBeenCalled();
});
