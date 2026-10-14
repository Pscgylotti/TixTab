import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novelRgba } from './observed-rgba.mjs';
test('accepts only complete RGBA tuples observed at the same position', () => {
  const refs = [
    Uint8Array.from([100, 200, 100, 255, 1, 2, 3, 255]),
    Uint8Array.from([101, 199, 100, 255, 4, 5, 6, 255]),
  ];
  assert.equal(novelRgba(Uint8Array.from([101, 199, 100, 255, 1, 2, 3, 255]), refs).novelPixels, 0);
  const mixed = novelRgba(Uint8Array.from([101, 200, 100, 255, 1, 2, 3, 255]), refs);
  assert.equal(mixed.novelPixels, 1);
  assert.equal(mixed.variableReferencePixels, 2);
  assert.equal(novelRgba(Uint8Array.from([1, 2, 3, 255, 100, 200, 100, 255]), refs).novelPixels, 2);
});
test('rejects unobserved one-level changes and alpha changes without a tolerance', () => {
  const ref = Uint8Array.from([50, 50, 50, 255]);
  assert.equal(novelRgba(Uint8Array.from([51, 50, 50, 255]), [ref]).novelPixels, 1);
  assert.equal(novelRgba(Uint8Array.from([50, 50, 50, 254]), [ref]).novelPixels, 1);
  assert.throws(() => novelRgba(ref, []), RangeError);
  assert.throws(() => novelRgba(ref, [ref.slice(1)]), RangeError);
});
