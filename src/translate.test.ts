import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localTranslate, releaseTranslation, translationReady } from './translate';
vi.mock('./modelLibrary', () => ({ requireLocalModels: async () => {} }));
let instance: FakeWorker;
class FakeWorker {
  onmessage?: (value: { data: unknown }) => void;
  onerror?: (value: { message: string }) => void;
  terminate = vi.fn();
  constructor() {
    instance = this;
  }
  postMessage() {}
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { baseURI: 'https://app.test/' });
});
afterEach(() => {
  releaseTranslation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('only marks a successful resident language direction ready and clears it on idle unload', async () => {
  expect(translationReady('zh-CN')).toBe(false);
  const job = localTranslate('Hello world', 'zh-CN', () => {});
  await Promise.resolve();
  expect(translationReady('zh-CN')).toBe(false);
  instance.onmessage!({ data: { type: 'result', text: '你好', elapsed: 1 } });
  await job;
  expect(translationReady('zh-CN')).toBe(true);
  expect(translationReady('en')).toBe(false);
  await vi.advanceTimersByTimeAsync(1800000);
  expect(translationReady('zh-CN')).toBe(false);
  expect(instance.terminate).toHaveBeenCalledOnce();
});
it('does not report a model ready during another job or after cancellation', async () => {
  const first = localTranslate('Hello world', 'zh-CN', () => {});
  await Promise.resolve();
  instance.onmessage!({ data: { type: 'result', text: '你好', elapsed: 1 } });
  await first;
  const controller = new AbortController();
  const second = localTranslate('Other text', 'zh-CN', () => {}, controller.signal);
  await Promise.resolve();
  expect(translationReady('zh-CN')).toBe(false);
  const assertion = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await assertion;
  expect(translationReady('zh-CN')).toBe(false);
});
