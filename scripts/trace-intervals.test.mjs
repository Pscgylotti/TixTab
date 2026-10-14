import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionTraceMs, isGCTraceName } from './trace-intervals.mjs';
test('GC matching includes V8 incremental/finalization wrappers without matching ordinary functions', () => {
  for (const name of [
    'MajorGC',
    'MinorGC',
    'V8.GCIncrementalMarking',
    'V8.GCFinalizeMCReduceMemory',
    'V8.GC_MC_BACKGROUND_MARKING',
    'BlinkGC.AtomicPhase',
  ])
    assert.equal(isGCTraceName(name), true, name);
  for (const name of ['RunTask', 'drawImage', 'myGCHandler', 'Network.GCRequest', null, undefined])
    assert.equal(isGCTraceName(name), false, String(name));
});
test('nested, overlapping, adjacent and unordered GC spans count wall time only once', () => {
  assert.equal(
    unionTraceMs(
      [
        [2500, 4000],
        [1000, 3000],
        [1500, 2000],
        [4000, 5000],
      ],
      0,
      6000,
    ),
    4,
  );
});
test('phase clipping excludes outside events and retains crossings', () => {
  assert.equal(
    unionTraceMs(
      [
        [-2000, 1500],
        [2500, 6000],
        [6000, 8000],
      ],
      1000,
      3000,
    ),
    1,
  );
});
test('parallel thread union is not a sum of thread times', () => {
  const a = [[1000, 4000]],
    b = [[2000, 5000]];
  assert.equal(unionTraceMs([...a, ...b], 0, 6000), 4);
  assert.equal(unionTraceMs(a, 0, 6000) + unionTraceMs(b, 0, 6000), 6);
});
test('empty and invalid-duration spans contribute no wall time', () => {
  assert.equal(
    unionTraceMs(
      [
        [0, 0],
        [5000, 4000],
        [NaN, 1],
        [0, Infinity],
      ],
      0,
      10000,
    ),
    0,
  );
  assert.equal(unionTraceMs([], 0, 10000), 0);
});
