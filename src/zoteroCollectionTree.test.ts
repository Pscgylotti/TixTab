import { test, expect } from 'vitest';
import { collectionRows } from './zoteroCollectionTree';
const folder = (key: string, name: string, parent: string | null = null) => ({ key, name, parent });
const rows = [
  folder('A', 'Arch'),
  folder('B', 'Attention', 'A'),
  folder('C', 'Flow Matching', 'A'),
  folder('D', 'Methods', 'B'),
  folder('E', 'Agent'),
];
test('true parent hierarchy, alphabetical roots and disclosure visibility', () => {
  expect(collectionRows(rows, new Set()).map((r) => r.collection.name)).toEqual(['Agent', 'Arch']);
  expect(
    collectionRows(rows, new Set(['A', 'B'])).map((r) => [r.collection.name, r.depth]),
  ).toEqual([
    ['Agent', 0],
    ['Arch', 0],
    ['Attention', 1],
    ['Methods', 2],
    ['Flow Matching', 1],
  ]);
});
test('filter preserves ancestors and temporarily reveals collapsed matching folders', () => {
  expect(collectionRows(rows, new Set(), 'METHOD').map((r) => r.collection.name)).toEqual([
    'Arch',
    'Attention',
    'Methods',
  ]);
  expect(collectionRows(rows, new Set(), 'unmatched')).toEqual([]);
});
test('partially loaded parents and malformed cycles never hide folders or recurse forever', () => {
  const incomplete = [folder('CHILD', 'Child', 'PARENT')];
  expect(collectionRows(incomplete, new Set())[0].depth).toBe(0);
  expect(
    collectionRows([...incomplete, folder('PARENT', 'Parent')], new Set(['PARENT'])).map(
      (r) => r.depth,
    ),
  ).toEqual([0, 1]);
  const cyclic = [folder('A', 'A', 'B'), folder('B', 'B', 'A'), folder('C', 'C', 'C')];
  expect(
    collectionRows(cyclic, new Set(['A', 'B', 'C']))
      .map((r) => r.collection.key)
      .sort(),
  ).toEqual(['A', 'B', 'C']);
});
test('deep folder libraries are traversed without depending on the JS call stack', () => {
  const deep = Array.from({ length: 10000 }, (_, i) =>
    folder(String(i), String(i), i ? String(i - 1) : null),
  );
  expect(collectionRows(deep, new Set(deep.map((c) => c.key)))).toHaveLength(10000);
  expect(collectionRows(deep, new Set(), '9999')).toHaveLength(10000);
});
