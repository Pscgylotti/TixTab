import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { unionTraceMs, isGCTraceName as isGC } from './trace-intervals.mjs';
const { values } = parseArgs({
  options: {
    trace: { type: 'string' },
    output: { type: 'string' },
    phase: { type: 'string', default: 'idle-tail' },
  },
});
if (!values.trace || !values.output) throw Error('Supply trace and fresh output');
const bytes = await readFile(values.trace),
  { traceEvents: events } = JSON.parse(bytes);
const start = events.find((e) => e.name === `workflow:${values.phase}:start`),
  end = events.find((e) => e.name === `workflow:${values.phase}:end`);
assert(start && end && end.ts > start.ts && start.pid === end.pid);
const names = new Map(
  events
    .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === start.pid)
    .map((e) => [e.tid, e.args.name]),
);
const gc = events
  .filter((e) => e.pid === start.pid && e.ph === 'X' && isGC(e.name) && e.dur > 0)
  .map((e) => ({ ...e, encoding: 'X' }));
const stacks = new Map();
let unpairedEnds = 0;
for (const e of events
  .filter((e) => e.pid === start.pid && (e.ph === 'B' || e.ph === 'E'))
  .sort((a, b) => a.ts - b.ts)) {
  const stack = stacks.get(e.tid) ?? [];
  stacks.set(e.tid, stack);
  if (e.ph === 'B') stack.push(e);
  else {
    const begin = stack.pop();
    if (begin && isGC(begin.name) && e.ts > begin.ts)
      gc.push({ ...begin, dur: e.ts - begin.ts, encoding: 'B/E' });
    else if (!begin && isGC(e.name)) unpairedEnds++;
  }
}
const relevant = gc.filter((e) => e.ts < end.ts && e.ts + e.dur > start.ts),
  spans = (xs) => xs.map((e) => [e.ts, e.ts + e.dur]);
const threads = [...new Set(relevant.map((e) => e.tid))]
  .map((tid) => {
    const items = relevant.filter((e) => e.tid === tid);
    return {
      tid,
      name: names.get(tid) ?? null,
      main: tid === start.tid,
      count: items.length,
      unionWallMs: unionTraceMs(spans(items), start.ts, end.ts),
    };
  })
  .sort((a, b) => b.unionWallMs - a.unionWallMs);
const roots = events
  .filter(
    (e) =>
      e.pid === start.pid &&
      e.tid === start.tid &&
      e.ph === 'X' &&
      e.name === 'RunTask' &&
      e.ts < end.ts &&
      e.ts + e.dur > start.ts,
  )
  .sort((a, b) => b.dur - a.dur)
  .slice(0, 12)
  .map((e) => ({
    startMs: (e.ts - start.ts) / 1000,
    wallMs: e.dur / 1000,
    gcUnionMs: unionTraceMs(
      spans(relevant.filter((g) => g.tid === start.tid)),
      Math.max(e.ts, start.ts),
      Math.min(e.ts + e.dur, end.ts),
    ),
    children: events
      .filter(
        (c) =>
          c.pid === e.pid &&
          c.tid === e.tid &&
          c.ph === 'X' &&
          c !== e &&
          c.ts >= e.ts &&
          c.ts + c.dur <= e.ts + e.dur,
      )
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 8)
      .map((c) => ({ name: c.name, wallMs: c.dur / 1000 })),
  }));
const result = {
  schema: 1,
  traceSha256: createHash('sha256').update(bytes).digest('hex'),
  harnessSha256: createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex'),
  intervalHarnessSha256: createHash('sha256')
    .update(await readFile(new URL('./trace-intervals.mjs', import.meta.url)))
    .digest('hex'),
  phase: values.phase,
  renderer: { pid: start.pid, tid: start.tid },
  wallMs: (end.ts - start.ts) / 1000,
  mainGCUnionWallMs: unionTraceMs(
    spans(relevant.filter((e) => e.tid === start.tid)),
    start.ts,
    end.ts,
  ),
  rendererGCUnionWallMs: unionTraceMs(spans(relevant), start.ts, end.ts),
  threads,
  names: [...new Set(relevant.map((e) => e.name))]
    .map((name) => {
      const items = relevant.filter((e) => e.name === name);
      return {
        name,
        count: items.length,
        maxWallMs: Math.max(...items.map((e) => e.dur / 1000)),
        unionWallMs: unionTraceMs(spans(items), start.ts, end.ts),
      };
    })
    .sort((a, b) => b.unionWallMs - a.unionWallMs),
  longest: relevant
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 20)
    .map((e) => ({
      name: e.name,
      tid: e.tid,
      thread: names.get(e.tid) ?? null,
      encoding: e.encoding,
      startMs: (e.ts - start.ts) / 1000,
      wallMs: e.dur / 1000,
      heapBefore: e.args?.usedHeapSizeBefore ?? e.args?.beginData?.usedHeapSize ?? null,
      heapAfter: e.args?.usedHeapSizeAfter ?? e.args?.endData?.usedHeapSize ?? null,
    })),
  unpairedGCStarts: [...stacks.values()].flat().filter((e) => isGC(e.name)).length,
  unpairedGCEnds: unpairedEnds,
  otherGCEventEncodings: Object.fromEntries(
    [
      ...new Set(
        events
          .filter(
            (e) =>
              e.pid === start.pid &&
              e.ts >= start.ts &&
              e.ts <= end.ts &&
              isGC(e.name) &&
              !['X', 'B', 'E'].includes(e.ph),
          )
          .map((e) => e.ph),
      ),
    ].map((ph) => [
      ph,
      events.filter(
        (e) =>
          e.pid === start.pid && e.ts >= start.ts && e.ts <= end.ts && isGC(e.name) && e.ph === ph,
      ).length,
    ]),
  ),
  roots,
  limits:
    'GC names are recognized trace categories, not a complete allocation diagnosis. Interval unions are wall time, not CPU or joules; parallel thread unions must not be added as elapsed time. Nested GC/root durations overlap. B/E matching assumes per-thread trace ordering. Tracing changes timing; these observations do not identify the cause of untraced idle samples.',
};
await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    phase: result.phase,
    wallMs: result.wallMs,
    mainGCUnionWallMs: result.mainGCUnionWallMs,
    rendererGCUnionWallMs: result.rendererGCUnionWallMs,
    threads: result.threads,
    roots: result.roots.slice(0, 3),
  }),
);
