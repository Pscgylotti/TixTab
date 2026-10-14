import type { Page } from './model';
export function prefetchTargets(
  pages: Page[],
  index: number,
  mode: 'single' | 'continuous' | 'dual',
  range: number,
) {
  if (![0, 0.5, 1, 2, 3, 4].includes(range) || range === 0) return [];
  const last = Math.min(pages.length - 1, index + (mode === 'dual' ? 1 : 0)),
    count = Math.ceil(range),
    targets: { page: Page; side?: 'top' | 'bottom' }[] = [];
  for (let distance = 1; distance <= count; distance++)
    for (const [at, side] of [
      [index - distance, 'bottom'],
      [last + distance, 'top'],
    ] as const) {
      const page = pages[at];
      if (page?.sourceIndex !== null && page)
        targets.push({ page, ...(range === 0.5 ? { side } : {}) });
    }
  return targets;
}
