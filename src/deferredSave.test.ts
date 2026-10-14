import { afterEach, expect, test, vi } from 'vitest';
import { deferredFormulaSave } from './deferredSave';

afterEach(() => vi.useRealTimers());

test('coalesces a burst and reads the latest complete draft only when writing', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let latest = 0;
  const stored: number[] = [];
  const saver = deferredFormulaSave(() => stored.push(latest));
  for (let i = 0; i < 200; i++) {
    latest++;
    saver.schedule();
    vi.advanceTimersByTime(2);
  }
  expect(stored).toEqual([]);
  vi.advanceTimersByTime(250);
  expect(stored).toEqual([200]);
  saver.flush();
  expect(stored).toEqual([200]);
});

test('continuous editing cannot postpone persistence beyond the deadline', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const saved = vi.fn();
  const saver = deferredFormulaSave(saved);
  for (let i = 0; i < 10; i++) {
    saver.schedule();
    vi.advanceTimersByTime(100);
  }
  expect(saved).toHaveBeenCalledTimes(1);
  saver.schedule();
  vi.advanceTimersByTime(250);
  expect(saved).toHaveBeenCalledTimes(2);
});

test('close flushes once synchronously, cancels delayed work and isolates other drafts', () => {
  vi.useFakeTimers();
  const a = vi.fn(),
    b = vi.fn();
  const left = deferredFormulaSave(a),
    right = deferredFormulaSave(b);
  left.schedule();
  right.schedule();
  left.flush();
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).not.toHaveBeenCalled();
  vi.advanceTimersByTime(250);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
});
