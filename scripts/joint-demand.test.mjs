import test from 'node:test';
import assert from 'node:assert/strict';
import { jointDemand, inferenceOverlap } from './joint-demand.mjs';

const report = (at, cpu, origin = 10000) => ({
  host: { logicalProcessors: 8 },
  clock: { timeOriginUnixMs: origin, wallOffsetAtEndMs: 0 },
  samples: at.map((time, i) => ({
    at: time,
    phase: 'scroll',
    processes: [{ pid: 1, cpu: { cumulativeCPUUsage: cpu[i] } }],
  })),
});
test('concurrent one-core workloads sum to two cores, not a doubled-time denominator', () => {
  const demand = jointDemand([
    { name: 'pdf', report: report([0, 1000], [0, 1]) },
    { name: 'asr', report: report([0, 1000], [0, 1]) },
  ]);
  assert.equal(demand.cpuSeconds, 2);
  assert.equal(demand.elapsedMs, 1000);
  assert.equal(demand.windows[200].coreEquivalent.p50, 2);
  assert.deepEqual(demand.windows[200].values[0].coverage, { pdf: 200, asr: 200 });
});
test('offset origins and idle tails retain all measured work exactly once', () => {
  const demand = jointDemand([
    { name: 'pdf', report: report([0, 1000], [0, 1]) },
    { name: 'asr', report: report([0, 1000, 2000], [0, 0.5, 0.5], 10500) },
  ]);
  assert.equal(demand.elapsedMs, 2500);
  assert.equal(demand.cpuSeconds, 1.5);
  assert.ok(
    Math.abs(demand.windows[200].values.reduce((s, w) => s + w.cpuSeconds, 0) - 1.5) < 1e-9,
  );
  assert.equal(demand.energyJoules, null);
});
test('clock drift is rejected and overlap uses only real inference phases', () => {
  const pdf = report([0, 1000], [0, 1]);
  const asr = {
    ...report([0, 1500], [0, 0.5]),
    phases: [
      { name: 'load-model', startMs: 0, endMs: 500 },
      { name: 'transcribe/zh-CN/0', startMs: 800, endMs: 1200 },
    ],
  };
  assert.equal(inferenceOverlap(pdf, asr, 'scroll'), 200);
  asr.clock.wallOffsetAtEndMs = 6;
  assert.throws(() => jointDemand([{ name: 'asr', report: asr }]), /unstable clock/);
});
