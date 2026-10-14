/** Opt-in, content-free completion accounting. Durations are wall time, not CPU or energy. */
export const performanceStages = [
  'pdf-document',
  'pdf-text',
  'pdf-images',
  'pdf-job',
  'pdf-page',
  'pdf-raster',
  'pdf-night',
  'pdf-display',
  'pdf-prefetch',
  'pdf-detail-plan',
  'view-settle',
  'render-resume',
  'pointer-recovery',
  'save-debounce',
  'workspace-save-queue',
  'workspace-transaction',
  'formula-save',
  'formula-save-queue',
  'formula-load',
  'formula-paint',
  'ink-paint',
  'foreground-view',
] as const;
export type PerformanceStage = (typeof performanceStages)[number];
export type PerformanceOutcome = 'completed' | 'cancelled' | 'failed';
export type PerformanceFinish = (outcome?: PerformanceOutcome) => void;
const counterNames = [
  'pdfPixels',
  'pdfCacheHits',
  'pdfTextExtractions',
  'pdfTextCacheHits',
  'pdfCacheEvictedBytes',
  'workspacePageWrites',
  'workspaceSourceWrites',
  'formulaWrites',
  'nightGpuConversions',
  'nightCpuConversions',
] as const;
type Counter = (typeof counterNames)[number];
interface StageTotals {
  pending: number;
  completed: number;
  cancelled: number;
  failed: number;
  wallMs: number;
  maxWallMs: number;
}
export class PerformanceLedger {
  private revision = 0;
  private pending = 0;
  private stages = Object.fromEntries(
    performanceStages.map((stage) => [
      stage,
      {
        pending: 0,
        completed: 0,
        cancelled: 0,
        failed: 0,
        wallMs: 0,
        maxWallMs: 0,
      },
    ]),
  ) as Record<PerformanceStage, StageTotals>;
  private counters = Object.fromEntries(counterNames.map((name) => [name, 0])) as Record<
    Counter,
    number
  >;
  constructor(private clock: () => number = () => performance.now()) {}
  begin(stage: PerformanceStage): PerformanceFinish {
    if (!performanceStages.includes(stage)) throw new RangeError('Unknown performance stage');
    const totals = this.stages[stage],
      start = this.clock();
    totals.pending++;
    this.pending++;
    this.revision++;
    let ended = false;
    return (outcome = 'completed') => {
      if (ended) return;
      if (!['completed', 'cancelled', 'failed'].includes(outcome))
        throw new RangeError('Unknown performance outcome');
      ended = true;
      totals.pending--;
      this.pending--;
      this.revision++;
      totals[outcome]++;
      const elapsed = Math.max(0, this.clock() - start);
      totals.wallMs += elapsed;
      totals.maxWallMs = Math.max(totals.maxWallMs, elapsed);
    };
  }
  track<T>(stage: PerformanceStage, run: () => Promise<T>): Promise<T> {
    const finish = this.begin(stage);
    try {
      const promise = run();
      // Observe the actual promise; return its identity and preserve rejection semantics.
      void promise.then(
        () => finish(),
        (error) => finish(performanceOutcome(error)),
      );
      return promise;
    } catch (error) {
      finish(performanceOutcome(error));
      throw error;
    }
  }
  count(name: Counter, value = 1) {
    if (!counterNames.includes(name) || !Number.isFinite(value) || value < 0)
      throw new RangeError('Invalid performance counter');
    this.counters[name] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[name] + value);
    this.revision++;
  }
  snapshot() {
    return {
      schema: 1 as const,
      now: this.clock(),
      revision: this.revision,
      pending: this.pending,
      stages: Object.fromEntries(
        performanceStages.map((stage) => [stage, { ...this.stages[stage] }]),
      ) as Record<PerformanceStage, StageTotals>,
      counters: { ...this.counters },
    };
  }
}
export function performanceOutcome(error: unknown): PerformanceOutcome {
  return error instanceof Error &&
    ['AbortError', 'RenderingCancelledException'].includes(error.name)
    ? 'cancelled'
    : 'failed';
}
function enabled() {
  try {
    return (
      typeof window !== 'undefined' && localStorage.getItem('tixtab.performance.enabled') === 'true'
    );
  } catch {
    return false;
  }
}
export const performanceLedger = enabled() ? new PerformanceLedger() : null;
export type PerformanceSnapshot = ReturnType<PerformanceLedger['snapshot']>;
declare global {
  interface Window {
    tixtabPerformance?: Readonly<{ snapshot: () => PerformanceSnapshot }>;
  }
}
if (performanceLedger && typeof window !== 'undefined') {
  Object.defineProperty(window, 'tixtabPerformance', {
    configurable: false,
    writable: false,
    value: Object.freeze({ snapshot: () => performanceLedger.snapshot() }),
  });
}
export function trackPerformance<T>(stage: PerformanceStage, run: () => Promise<T>) {
  return performanceLedger ? performanceLedger.track(stage, run) : run();
}
/** Replace an existing timer, never add a diagnostic polling loop/wakeup. */
export function performanceDelay(stage: PerformanceStage, callback: () => void, ms: number) {
  const finish = performanceLedger?.begin(stage);
  const timer = setTimeout(
    finish
      ? () => {
          try {
            callback();
            finish();
          } catch (error) {
            finish(performanceOutcome(error));
            throw error;
          }
        }
      : callback,
    ms,
  );
  return () => {
    clearTimeout(timer);
    finish?.('cancelled');
  };
}
