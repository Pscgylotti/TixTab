import { expect, it } from 'vitest';
import { blankPage } from './model';
import { prefetchTargets } from './pdfPrefetch';
it('defaults to adjacent pages, bounds ends and skips blank pages', () => {
  const pages = Array.from({ length: 10 }, (_, sourceIndex) => ({ ...blankPage(), sourceIndex }));
  expect(prefetchTargets(pages, 4, 'single', 1).map((t) => t.page.sourceIndex)).toEqual([3, 5]);
  expect(prefetchTargets(pages, 4, 'dual', 1).map((t) => t.page.sourceIndex)).toEqual([3, 6]);
  expect(prefetchTargets(pages, 0, 'single', 4)).toHaveLength(4);
  expect(prefetchTargets(pages, 4, 'single', 0)).toEqual([]);
  expect(prefetchTargets([blankPage(), ...pages], 1, 'single', 1)).toHaveLength(1);
});
it('half-page prefetch uses the previous bottom and next top', () => {
  const pages = Array.from({ length: 3 }, (_, sourceIndex) => ({ ...blankPage(), sourceIndex }));
  expect(
    prefetchTargets(pages, 1, 'single', 0.5).map((t) => ({
      index: t.page.sourceIndex,
      side: t.side,
    })),
  ).toEqual([
    { index: 0, side: 'bottom' },
    { index: 2, side: 'top' },
  ]);
});
