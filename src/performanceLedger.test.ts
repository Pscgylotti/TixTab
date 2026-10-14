import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PerformanceLedger,
  performanceDelay,
  performanceLedger,
  performanceOutcome,
  trackPerformance,
} from './performanceLedger';
afterEach(() => vi.useRealTimers());
describe('content-free performance completion ledger', () => {
  it('counts overlapping work and idempotent terminal outcomes without conflating wall time with CPU', () => {
    let time = 10;
    const ledger = new PerformanceLedger(() => time);
    const a = ledger.begin('pdf-job'),
      b = ledger.begin('pdf-raster');
    time = 30;
    b();
    b('failed');
    expect(ledger.snapshot()).toMatchObject({
      pending: 1,
      revision: 3,
      stages: { 'pdf-raster': { pending: 0, completed: 1, failed: 0, wallMs: 20 } },
    });
    time = 40;
    a('cancelled');
    const snapshot = ledger.snapshot();
    snapshot.stages['pdf-job'].pending = 99;
    expect(ledger.snapshot()).toMatchObject({
      pending: 0,
      revision: 4,
      stages: { 'pdf-job': { pending: 0, cancelled: 1, wallMs: 30 } },
    });
  });
  it('waits for underlying promises, including work whose caller has already given up', async () => {
    const ledger = new PerformanceLedger();
    let resolve!: (n: number) => void;
    const promise = new Promise<number>((yes) => {
      resolve = yes;
    });
    expect(ledger.track('pdf-page', () => promise)).toBe(promise);
    expect(ledger.snapshot().pending).toBe(1);
    // An external timeout does not finish the tracked operation.
    await Promise.race([promise, Promise.resolve('timeout')]);
    expect(ledger.snapshot().pending).toBe(1);
    resolve(42);
    await promise;
    expect(ledger.snapshot().pending).toBe(0);
  });
  it('records failures/cancellation and preserves thrown/rejected values without storing their messages', async () => {
    const ledger = new PerformanceLedger(),
      secret = new Error('sensitive document/account material');
    expect(() =>
      ledger.track('formula-save', () => {
        throw secret;
      }),
    ).toThrow(secret);
    await expect(
      ledger.track('pdf-raster', () => Promise.reject(new DOMException('secret', 'AbortError'))),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ledger.snapshot().stages['formula-save'].failed).toBe(1);
    expect(ledger.snapshot().stages['pdf-raster'].cancelled).toBe(1);
    expect(JSON.stringify(ledger.snapshot())).not.toMatch(/sensitive|secret|document\/account/);
    expect(performanceOutcome(new Error('failure'))).toBe('failed');
  });
  it('only accepts fixed stage/counter names and finite positive counts', () => {
    const ledger = new PerformanceLedger();
    ledger.count('pdfPixels', 200);
    expect(ledger.snapshot().counters.pdfPixels).toBe(200);
    // @ts-expect-error forbid content as a category
    expect(() => ledger.begin('PDF contents')).toThrow(RangeError);
    // @ts-expect-error forbid content as a counter name
    expect(() => ledger.count('account', 1)).toThrow(RangeError);
    expect(() => ledger.count('pdfPixels', NaN)).toThrow(RangeError);
    expect(() => ledger.count('pdfPixels', -1)).toThrow(RangeError);
  });
  it('disabled instrumentation preserves promise identity and adds no timers; wrapped delays remain cancellable', async () => {
    vi.useFakeTimers();
    expect(performanceLedger).toBeNull();
    const promise = Promise.resolve(7);
    expect(trackPerformance('pdf-job', () => promise)).toBe(promise);
    expect(vi.getTimerCount()).toBe(0);
    const callback = vi.fn(),
      cancel = performanceDelay('view-settle', callback, 120);
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    vi.advanceTimersByTime(500);
    expect(callback).not.toHaveBeenCalled();
    performanceDelay('view-settle', callback, 120);
    vi.advanceTimersByTime(120);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
