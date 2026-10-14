import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuIntervals,
  demandWindows,
  demandModel,
  requireComparable,
  primeCpuCounters,
} from './performance-demand.mjs';
const process = (pid, seconds) => ({ pid, cpu: { cumulativeCPUUsage: seconds } });

test('counter warmup retains resets/process changes and requires consecutive stable pairs', async () => {
  const readings = [
    [process(1, 1)],
    [process(1, 0.8)],
    [process(1, 0.9)],
    [{ ...process(1, 1), creationTime: 100 }],
    [{ ...process(1, 1.1), creationTime: 100 }],
    [{ ...process(1, 1.2), creationTime: 100 }],
  ];
  let i = 0;
  const waits = [];
  const result = await primeCpuCounters(
    async () => ({ at: i * 200, processes: readings[i++] }),
    async (ms) => waits.push(ms),
  );
  assert.equal(i, 6);
  assert.equal(result.samples.length, 6);
  assert.deepEqual(waits, Array(5).fill(200));
  assert.equal(result.stablePairs, 2);
  assert.equal(cpuIntervals(result.samples)[0].unmatched, 2);
  // Missing/invalid counters cannot appear stable, even if all reads are identical.
  let at = 0;
  await assert.rejects(
    primeCpuCounters(
      async () => ({ at: at++, processes: [process(1, undefined)] }),
      async () => {},
      { maxReads: 4 },
    ),
    /did not initialize/,
  );
  await assert.rejects(
    primeCpuCounters(
      async () => ({ at: at++, processes: [] }),
      async () => {},
      { maxReads: 4 },
    ),
    /did not initialize/,
  );
});
test('CPU deltas and time bins conserve total demand across sampling boundaries', () => {
  const intervals = cpuIntervals([
    { at: 0, processes: [process(1, 1), process(2, 2)] },
    { at: 150, processes: [process(1, 1.1), process(2, 2.05)] },
    { at: 420, processes: [process(1, 1.2), process(2, 2.15)] },
  ]);
  for (const ms of [200, 1000]) {
    const windows = demandWindows(intervals, ms, 8);
    assert.ok(Math.abs(windows.reduce((n, w) => n + w.cpuSeconds, 0) - 0.35) < 1e-12);
    assert.equal(
      windows.reduce((n, w) => n + w.coveredMs, 0),
      420,
    );
    assert.ok(
      windows.every((w) => Math.abs(w.machinePercent - (w.coreEquivalent * 100) / 8) < 1e-12),
    );
  }
});
test('missing/reset/short-lived processes are explicit, never mistaken for observed energy', () => {
  const samples = [
    { at: 0, processes: [process(1, 9), process(2, 1)] },
    { at: 200, processes: [process(1, 0.1), process(3, 0.4)] },
  ];
  const model = demandModel({ samples, host: { logicalProcessors: 8 } });
  assert.equal(model.totalCpuSeconds, 0);
  assert.equal(model.unmatchedProcessIntervals, 1);
  for (const key of ['energyJoules', 'gpuActiveSeconds', 'npuActiveSeconds', 'ioBytes', 'wakeups'])
    assert.equal(model[key], null);
});
test('mismatched quality or harness cannot be pooled into an A/B claim', () => {
  const report = {
    label: 'A',
    errors: [],
    harnessSha256: 'a'.repeat(64),
    buildSha256: 'b'.repeat(64),
    fixture: { sha256: 'c'.repeat(64) },
    samples: [{ at: 0 }],
    visuals: { quality: 'high' },
    host: { cpu: 'test', logicalProcessors: 8 },
    rows: [{ name: 'write' }],
  };
  requireComparable([report, { ...report, label: 'B' }]);
  assert.throws(
    () => requireComparable([report, { ...report, visuals: { quality: 'standard' } }]),
    /visualPolicy/,
  );
  assert.throws(
    () => requireComparable([report, { ...report, harnessSha256: 'd'.repeat(64) }]),
    /harness/,
  );
  assert.throws(() => requireComparable([{ ...report, buildSha256: undefined }]), /provenance/);
});
test('completion-gated reports cannot hide pending/failed work or mix legacy waits', () => {
  const gate = { schema: 1, enabled: true, quietMs: 800 };
  const done = { pending: 0, stages: { 'pdf-job': { pending: 0, failed: 0 } } };
  const row = {
    name: 'write',
    completionAfter: done,
    checkpoints: [{ ledger: done, quietMs: 800 }],
  };
  const report = {
    label: 'A',
    errors: [],
    harnessSha256: 'a'.repeat(64),
    buildSha256: 'b'.repeat(64),
    fixture: { sha256: 'c'.repeat(64) },
    samples: [{ at: 0 }],
    visuals: {},
    host: { cpu: 'test', logicalProcessors: 8 },
    rows: [row],
    completionGate: gate,
  };
  requireComparable([report, { ...report, label: 'B' }]);
  assert.throws(
    () =>
      requireComparable([
        { ...report, rows: [{ ...row, completionAfter: { ...done, pending: 1 } }] },
      ]),
    /unfinished/,
  );
  assert.throws(
    () => requireComparable([{ ...report, rows: [{ ...row, checkpoints: [] }] }]),
    /checkpoint/,
  );
  assert.throws(
    () =>
      requireComparable([
        {
          ...report,
          rows: [
            {
              ...row,
              completionAfter: { pending: 0, stages: { 'pdf-job': { pending: 0, failed: 1 } } },
            },
          ],
        },
      ]),
    /failed/,
  );
  assert.throws(
    () => requireComparable([report, { ...report, completionGate: undefined }]),
    /completionGate/,
  );
});
