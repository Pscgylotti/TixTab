import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { values } = parseArgs({
  options: {
    trace: { type: 'string' },
    output: { type: 'string' },
    phase: { type: 'string', default: 'import-mixed-document' },
  },
});
if (!values.trace || !values.output) throw Error('Supply --trace and fresh --output');
const traceBytes = await readFile(values.trace);
const { traceEvents: events } = JSON.parse(traceBytes.toString('utf8'));
const mark = (suffix) => events.find((e) => e.name === `workflow:${values.phase}:${suffix}`);
const start = mark('start'),
  end = mark('end');
assert(start && end && end.ts > start.ts, 'Missing phase markers');
const renderer = { pid: start.pid, tid: start.tid };
const devtools = events.filter(
  (e) =>
    e.ph === 'X' &&
    e.pid === renderer.pid &&
    e.tid === renderer.tid &&
    e.ts >= start.ts &&
    e.ts < end.ts &&
    e.name === 'Receive mojo message' &&
    e.args?.chrome_mojo_event_info?.mojo_interface_tag === 'blink.mojom.DevToolsSession',
);
const roots = events
  .filter(
    (e) =>
      e.ph === 'X' &&
      e.name === 'RunTask' &&
      e.pid === renderer.pid &&
      e.tid === renderer.tid &&
      e.ts < end.ts &&
      e.ts + e.dur > start.ts,
  )
  .sort((a, b) => b.dur - a.dur);
assert(roots.length, 'Trace lacks renderer root tasks');
const rootSummary = (root) => ({
  startMs: (root.ts - start.ts) / 1000,
  durMs: root.dur / 1000,
  children: events
    .filter(
      (e) =>
        e.ph === 'X' &&
        e.pid === renderer.pid &&
        e.tid === renderer.tid &&
        e.ts >= root.ts &&
        e.ts + (e.dur ?? 0) <= root.ts + root.dur &&
        e !== root,
    )
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 12)
    .map((e) => ({ name: e.name, durMs: e.dur / 1000, args: e.args })),
});
const profiles = new Map();
for (const e of events)
  if (e.name === 'Profile' && e.pid === renderer.pid && e.tid === renderer.tid)
    profiles.set(`${e.pid}:${e.id}`, {
      start: e.args.data.startTime,
      nodes: new Map(),
      chunks: [],
    });
for (const e of events)
  if (e.name === 'ProfileChunk' && e.pid === renderer.pid) {
    const profile = profiles.get(`${e.pid}:${e.id}`);
    if (!profile) continue;
    const data = e.args.data;
    for (const node of data.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
    profile.chunks.push(data);
  }
const samples = [];
for (const p of profiles.values()) {
  let clock = p.start;
  for (const chunk of p.chunks) {
    const ids = chunk.cpuProfile?.samples ?? [],
      deltas = chunk.timeDeltas ?? [];
    assert.equal(ids.length, deltas.length, 'Sampling count mismatch');
    for (let i = 0; i < ids.length; i++) {
      clock += deltas[i];
      if (clock < start.ts || clock > end.ts) continue;
      const stack = [],
        visited = new Set();
      let id = ids[i];
      while (id && !visited.has(id)) {
        visited.add(id);
        const node = p.nodes.get(id);
        if (!node) break;
        stack.push(node.callFrame);
        id = node.parent;
      }
      samples.push({ ts: clock, delta: deltas[i], stack });
    }
  }
}
const hot = (from, to) => {
  const totals = new Map();
  for (const sample of samples) {
    if (sample.ts < from || sample.ts > to) continue;
    const frame = sample.stack[0];
    if (!frame) continue;
    const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}:${frame.functionName}`;
    const value = totals.get(key) ?? {
      frame,
      approximateMs: 0,
      count: 0,
      stack: sample.stack.slice(0, 10),
    };
    value.approximateMs += sample.delta / 1000;
    value.count++;
    totals.set(key, value);
  }
  return [...totals.values()].sort((a, b) => b.approximateMs - a.approximateMs).slice(0, 20);
};
const result = {
  schema: 1,
  traceSha256: createHash('sha256').update(traceBytes).digest('hex'),
  harnessSha256: createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex'),
  phase: values.phase,
  trace: values.trace,
  eventCount: events.length,
  renderer,
  devtoolsMessages: {
    count: devtools.length,
    maxPayloadBytes: Math.max(
      0,
      ...devtools.map((e) => e.args.chrome_mojo_event_info.payload_size ?? 0),
    ),
    maxWallMs: Math.max(0, ...devtools.map((e) => e.dur / 1000)),
  },
  wallMs: (end.ts - start.ts) / 1000,
  roots: roots.slice(0, 12).map(rootSummary),
  samples: samples.length,
  hot: hot(start.ts, end.ts),
  rootHot: roots.slice(0, 4).map((root) => ({
    startMs: (root.ts - start.ts) / 1000,
    durMs: root.dur / 1000,
    hot: hot(root.ts, root.ts + root.dur),
  })),
  limits:
    'Tracing/profiling overhead is included. Root duration is wall time, not CPU or device energy. Nested durations overlap and must not be summed. V8 samples approximate time and can include sampling/scheduling delays. Compare ordinary untraced runs separately.',
};
await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    phase: values.phase,
    wallMs: result.wallMs,
    samples: samples.length,
    roots: result.roots
      .slice(0, 5)
      .map((r) => ({ startMs: r.startMs, durMs: r.durMs, child: r.children[1] })),
    hot: result.hot
      .slice(0, 5)
      .map((x) => ({ frame: x.frame, ms: x.approximateMs, count: x.count })),
  }),
);
