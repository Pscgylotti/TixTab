import { unionTraceMs, isGCTraceName } from './trace-intervals.mjs';

/** Attribute only the outermost FunctionCall of each RAF, on the marker thread. */
export function frameBudgetRows(events, start, end, classify) {
  const main = events.filter(
    (e) =>
      e.ph === 'X' &&
      e.pid === start.pid &&
      e.tid === start.tid &&
      Number.isFinite(e.dur) &&
      e.dur > 0 &&
      e.ts < end.ts &&
      e.ts + e.dur > start.ts,
  );
  const roots = main.filter((e) => e.name === 'RunTask');
  const calls = main
    .filter((e) => e.name === 'FunctionCall')
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const callbacks = main
    .filter((e) => e.name === 'FireAnimationFrame')
    .map((e) => {
      const call = calls.find((c) => c.ts >= e.ts && c.ts + c.dur <= e.ts + e.dur);
      const mapping = call && classify(call.args?.data);
      const root = roots
        .filter((r) => r.ts <= e.ts && r.ts + r.dur >= e.ts + e.dur)
        .sort((a, b) => a.dur - b.dur)[0];
      return { event: e, root, kind: mapping?.kind ?? 'other', mapping, call: call?.args?.data };
    });
  return roots
    .map((root) => {
      const raf = callbacks.filter((c) => c.root === root);
      const interval = (e) => [e.ts, e.ts + e.dur];
      const contained = main.filter((e) => e.ts >= root.ts && e.ts + e.dur <= root.ts + root.dur);
      const union = (list) =>
        unionTraceMs(
          list.map(interval),
          Math.max(start.ts, root.ts),
          Math.min(end.ts, root.ts + root.dur),
        );
      return {
        startMs: (root.ts - start.ts) / 1000,
        rootWallMs: (Math.min(end.ts, root.ts + root.dur) - Math.max(start.ts, root.ts)) / 1000,
        rafCount: raf.length,
        pdfCallbacks: raf.filter((c) => c.kind === 'pdf').length,
        foregroundCallbacks: raf.filter((c) => c.kind === 'foreground').length,
        rafUnionMs: union(raf.map((c) => c.event)),
        pdfRafUnionMs: union(raf.filter((c) => c.kind === 'pdf').map((c) => c.event)),
        layoutUnionMs: union(
          contained.filter((e) => e.name === 'Layout' || e.name === 'UpdateLayoutTree'),
        ),
        commitUnionMs: union(contained.filter((e) => e.name === 'Commit')),
        gcUnionMs: union(contained.filter((e) => isGCTraceName(e.name))),
        callbacks: raf.map(({ event, kind, mapping, call }) => ({
          kind,
          id: event.args?.data?.id,
          wallMs: event.dur / 1000,
          mapping,
          call,
        })),
      };
    })
    .sort((a, b) => b.rootWallMs - a.rootWallMs);
}
