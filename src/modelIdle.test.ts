import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getModelIdleSeconds, setModelIdleSeconds, scheduleModelIdle } from './modelIdle';
import { setMemoryMode } from './appearance';
let store: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  vi.stubGlobal('window', {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  setModelIdleSeconds(1800);
});
afterEach(() => {
  setMemoryMode('normal');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('memory mode never changes the user-controlled model idle timeout', async () => {
  const release = vi.fn();
  const cancel = scheduleModelIdle(release);
  await vi.advanceTimersByTimeAsync(20000);
  setMemoryMode('minimal');
  expect(getModelIdleSeconds()).toBe(1800);
  expect(store.get('surfacetab.modelIdleSeconds')).toBe('1800');
  await vi.advanceTimersByTimeAsync(10000);
  expect(release).not.toHaveBeenCalled();
  cancel();
  setMemoryMode('normal');
  expect(getModelIdleSeconds()).toBe(1800);
});
it('defaults to 1800 seconds, persists valid values and rejects invalid limits', () => {
  expect(getModelIdleSeconds()).toBe(1800);
  setModelIdleSeconds(60);
  expect(getModelIdleSeconds()).toBe(60);
  for (const value of [0, 29, 86401, NaN, 30.5]) expect(() => setModelIdleSeconds(value)).toThrow();
  expect(getModelIdleSeconds()).toBe(60);
});
it('rearms against elapsed idle time, frees once and cancels when work resumes', async () => {
  const release = vi.fn();
  const cancel = scheduleModelIdle(release);
  await vi.advanceTimersByTimeAsync(100000);
  expect(release).not.toHaveBeenCalled();
  setModelIdleSeconds(120);
  await vi.advanceTimersByTimeAsync(19999);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(release).toHaveBeenCalledOnce();
  setModelIdleSeconds(30);
  cancel();
  const second = scheduleModelIdle(release);
  second();
  await vi.advanceTimersByTimeAsync(1800000);
  expect(release).toHaveBeenCalledOnce();
});
