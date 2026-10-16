import { describe, it, expect, vi } from 'vitest';
import { createTailGesture } from './penTailVoice';
import { createRequire } from 'node:module';
const { tailKey } = createRequire(import.meta.url)('../electron/pen-tail-voice.cjs');
describe('foreground-only Surface tail key policy', () => {
  it('consumes one F20 press and release, rejects repeats and passes all unrelated keys', () => {
    const state = { down: false };
    let calls = 0;
    expect(tailKey(state, 0x100, 0x41, true, () => calls++)).toBe(false);
    expect(tailKey(state, 0x100, 0x83, false, () => calls++)).toBe(false);
    expect(tailKey(state, 0x100, 0x83, true, () => calls++)).toBe(true);
    expect(tailKey(state, 0x100, 0x83, true, () => calls++)).toBe(true);
    expect(calls).toBe(1);
    expect(tailKey(state, 0x101, 0x83, false, () => calls++)).toBe(true);
    expect(tailKey(state, 0x101, 0x83, false, () => calls++)).toBe(false);
    expect(tailKey(state, 0x104, 0x83, true, () => calls++)).toBe(true);
    expect(tailKey(state, 0x105, 0x83, true, () => calls++)).toBe(true);
    expect(calls).toBe(2);
  });
});
it('supports the native F19 double-click gesture only in the foreground', () => {
  const state = { down: false };
  const emit = vi.fn();
  expect(tailKey(state, 0x100, 0x82, false, emit)).toBe(false);
  expect(tailKey(state, 0x100, 0x82, true, emit)).toBe(true);
  expect(emit).toHaveBeenCalledWith('send');
  expect(tailKey(state, 0x100, 0x82, true, emit)).toBe(true);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(tailKey(state, 0x101, 0x83, true, emit)).toBe(false);
  expect(tailKey(state, 0x101, 0x82, true, emit)).toBe(true);
});
it('distinguishes single, repeated and native double gestures and drops pending presses on opt-out', () => {
  vi.useFakeTimers();
  const single = vi.fn(),
    double = vi.fn(),
    gesture = createTailGesture(single, double);
  try {
    gesture.press();
    vi.advanceTimersByTime(500);
    expect(single).toHaveBeenCalledTimes(1);
    expect(double).not.toHaveBeenCalled();
    gesture.press();
    vi.advanceTimersByTime(100);
    gesture.press();
    vi.advanceTimersByTime(500);
    expect(single).toHaveBeenCalledTimes(1);
    expect(double).toHaveBeenCalledTimes(1);
    gesture.press();
    gesture.press('send');
    vi.advanceTimersByTime(500);
    expect(single).toHaveBeenCalledTimes(1);
    expect(double).toHaveBeenCalledTimes(2);
    gesture.press();
    gesture.dispose();
    vi.advanceTimersByTime(500);
    expect(single).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    gesture.dispose();
    vi.useRealTimers();
  }
});
