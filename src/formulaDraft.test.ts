import { beforeEach, expect, test, vi } from 'vitest';
const memory = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => {
    memory.set(key, value);
  },
  keys: async () => [...memory.keys()],
  delMany: async (keys: string[]) => {
    keys.forEach((key) => memory.delete(key));
  },
}));
import {
  formulaDraftKey,
  validFormulaDraft,
  loadFormulaDraft,
  saveFormulaDraft,
  deleteFormulaDrafts,
  type FormulaDraft,
} from './formulaDraft';
const draft = (): FormulaDraft => ({
  version: 1,
  latex: 'a+x^2+b',
  position: 2,
  multiline: true,
  byRow: false,
  macros: { '\\RR': '\\mathbb{R}' },
  macroDraft: '\\newcommand{\\RR}{\\mathbb{R}}',
  strokes: [
    {
      id: 'ink',
      tool: 'pen',
      color: '#202a40',
      size: 5,
      points: [
        [100, 400, 0.5],
        [200, 420, 0.9],
      ],
    },
  ],
});
beforeEach(() => memory.clear());
test('drafts preserve source, cursor and immutable vector ink snapshots', async () => {
  const value = draft(),
    key = formulaDraftKey('document');
  await saveFormulaDraft(key, value);
  value.strokes[0].points.push([300, 450, 1]);
  const restored = await loadFormulaDraft(key);
  expect(restored).toEqual({
    ...value,
    strokes: [
      {
        ...value.strokes[0],
        points: [
          [100, 400, 0.5],
          [200, 420, 0.9],
        ],
      },
    ],
  });
  expect(restored?.position).toBe(2);
});
test('document and object keys cannot collide and deleting a document only removes its drafts', async () => {
  const a = formulaDraftKey('doc'),
    b = formulaDraftKey('doc', 'object'),
    c = formulaDraftKey('doc:object');
  expect(new Set([a, b, c]).size).toBe(3);
  for (const key of [a, b, c]) await saveFormulaDraft(key, draft());
  memory.set('chat:doc', 'keep');
  await deleteFormulaDrafts('doc');
  expect(await loadFormulaDraft(a)).toBeUndefined();
  expect(await loadFormulaDraft(b)).toBeUndefined();
  expect(await loadFormulaDraft(c)).toBeDefined();
  expect(memory.get('chat:doc')).toBe('keep');
});
test('invalid or corrupt stored drafts are rejected without rendering malformed ink', async () => {
  expect(validFormulaDraft(draft())).toBe(true);
  for (const value of [
    null,
    {},
    { ...draft(), position: -1 },
    { ...draft(), position: 100 },
    { ...draft(), strokes: [null] },
    { ...draft(), strokes: [{ ...draft().strokes[0], points: [[NaN, 0, 1]] }] },
  ]) {
    expect(validFormulaDraft(value)).toBe(false);
  }
  const key = formulaDraftKey('document');
  memory.set(key, { ...draft(), latex: 123 });
  expect(await loadFormulaDraft(key)).toBeUndefined();
});
