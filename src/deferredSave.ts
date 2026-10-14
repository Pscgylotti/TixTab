import { performanceDelay } from './performanceLedger';

/** Coalesce changes, with a deadline even during continuous editing. Reads at flush time. */
export function deferredFormulaSave(save: () => void, delay = 250, maxWait = 1000) {
  let cancel: (() => void) | undefined;
  let first = 0;
  const flush = () => {
    if (!cancel) return;
    cancel();
    cancel = undefined;
    save();
  };
  return {
    schedule() {
      if (!cancel) first = performance.now();
      cancel?.();
      cancel = performanceDelay(
        'formula-save-queue',
        () => {
          cancel = undefined;
          save();
        },
        Math.max(0, Math.min(delay, maxWait - (performance.now() - first))),
      );
    },
    flush,
  };
}
