import { expect, it } from 'vitest';
import { blankPage, type Notebook } from './model';
import { historyTarget, historyViewportIndex } from './historyNavigation';
it('jumps to the changed page even when reading elsewhere, in both undo and redo directions', () => {
  const a = blankPage(),
    b = blankPage(),
    c = blankPage(),
    n: Notebook = { version: 1, name: 'test', source: null, pages: [a, b, c] },
    edited = {
      ...n,
      pages: [
        a,
        {
          ...b,
          strokes: [
            {
              id: 's',
              tool: 'pen' as const,
              color: '#000000',
              size: 2,
              points: [[1, 2, 0.5] as [number, number, number]],
            },
          ],
        },
        c,
      ],
    };
  expect(historyTarget(edited, n, c.id)).toBe(1);
  expect(historyTarget(n, edited, a.id)).toBe(1);
});
it('locates restored/deleted/inserted and reordered pages without stale indices', () => {
  const a = blankPage(),
    b = blankPage(),
    c = blankPage(),
    n: Notebook = { version: 1, name: 'test', source: null, pages: [a, b, c] };
  expect(historyTarget({ ...n, pages: [a, c] }, n, a.id)).toBe(1);
  expect(historyTarget(n, { ...n, pages: [a, c] }, a.id)).toBe(1);
  expect(historyTarget(n, { ...n, pages: [b, c, a] }, b.id)).toBe(2);
});
it('keeps the spread when undo targets its right page, but navigates to targets outside it', () => {
  const a = blankPage(),
    b = blankPage(),
    c = blankPage(),
    n: Notebook = { version: 1, name: 'dual', source: null, pages: [a, b, c] };
  expect(historyViewportIndex(n, 1, a.id, 'dual')).toBe(0);
  expect(historyViewportIndex(n, 2, a.id, 'dual')).toBe(2);
  expect(historyViewportIndex(n, 1, a.id, 'continuous')).toBe(1);
});
