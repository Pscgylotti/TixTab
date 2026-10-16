import { describe, it, expect } from 'vitest';
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
