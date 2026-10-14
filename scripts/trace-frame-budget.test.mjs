import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameBudgetRows } from './trace-frame-budget.mjs';
const marker = (ts) => ({ ts, pid: 1, tid: 2 });
const event = (name, ts, dur, fn, extra = {}) => ({
  name,
  ts,
  dur,
  ph: 'X',
  pid: 1,
  tid: 2,
  args: { data: { fn } },
  ...extra,
});
const classify = (d) =>
  d?.fn === 'pdf' ? { kind: 'pdf' } : d?.fn === 'foreground' ? { kind: 'foreground' } : null;
test('counts two PDF callbacks within one root, without nested or worker double-counting', () => {
  const rows = frameBudgetRows(
    [
      event('RunTask', 0, 100),
      event('FireAnimationFrame', 10, 20),
      event('FunctionCall', 11, 18, 'pdf'),
      event('FunctionCall', 12, 10, 'pdf'),
      event('FireAnimationFrame', 40, 20),
      event('FunctionCall', 41, 18, 'pdf'),
      event('FireAnimationFrame', 65, 20),
      event('FunctionCall', 66, 18, 'foreground'),
      event('FireAnimationFrame', 10, 20, undefined, { tid: 3 }),
      event('FunctionCall', 11, 18, 'pdf', { tid: 3 }),
    ],
    marker(0),
    marker(100),
    classify,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pdfCallbacks, 2);
  assert.equal(rows[0].foregroundCallbacks, 1);
  assert.equal(rows[0].rafUnionMs, 0.06);
  assert.equal(rows[0].pdfRafUnionMs, 0.04);
});
test('nested RunTask gets one owner and phase crossing intervals are clipped', () => {
  const rows = frameBudgetRows(
    [
      event('RunTask', 0, 100),
      event('RunTask', 20, 50),
      event('FireAnimationFrame', 30, 20),
      event('FunctionCall', 31, 18, 'pdf'),
    ],
    marker(40),
    marker(90),
    classify,
  );
  const outer = rows.find((r) => r.startMs === -0.04),
    inner = rows.find((r) => r.startMs === -0.02);
  assert.equal(outer.pdfCallbacks, 0);
  assert.equal(inner.pdfCallbacks, 1);
  assert.equal(inner.pdfRafUnionMs, 0.01);
});
test('layout/GC categories use union spans, not sum of nested wrapper durations', () => {
  const [r] = frameBudgetRows(
    [
      event('RunTask', 0, 100),
      event('Layout', 10, 40),
      event('UpdateLayoutTree', 20, 20),
      event('MajorGC', 60, 20),
      event('V8.GC_MARK_COMPACTOR', 62, 10),
    ],
    marker(0),
    marker(100),
    classify,
  );
  assert.equal(r.layoutUnionMs, 0.04);
  assert.equal(r.gcUnionMs, 0.02);
  assert.equal(r.rafCount, 0);
});
