import { test, expect } from '@playwright/test';

test('reading ink retains current geometry, appearance and order across edits, culling and remount', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.workspace-heading').waitFor();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(async () => {
    const { mountReadingInk } = await import('/tests/fixtures/readingInkFixture.tsx');
    const container = document.createElement('div');
    container.id = 'reading-ink-fixture';
    Object.assign(container.style, {
      position: 'fixed',
      top: '100px',
      left: '100px',
      zIndex: '20000',
    });
    document.body.append(container);
    const original = {
      id: 'ink-update-page',
      sourceIndex: null,
      width: 640,
      height: 1900,
      paper: 'plain',
      images: [],
      strokes: Array.from({ length: 320 }, (_, index) => ({
        id: `ink-update-${index}`,
        tool: 'pen',
        color: '#112233',
        size: 3,
        points: [0, 1, 2].map((n) => [
          40 + (index % 8) * 70 + n * 5,
          40 + Math.floor(index / 8) * 45 + n * 3,
          0.5,
        ]),
      })),
    };
    (window as any).readingInkTest = {
      container,
      original,
      current: original,
      mountReadingInk,
      fixture: mountReadingInk(container, original),
    };
  });
  const layer = page.locator('#reading-ink-fixture .reading-ink');
  await expect
    .poll(async () => Number(await layer.getAttribute('data-visible-strokes')))
    .toBeLessThan(320);
  const state = async () =>
    page.evaluate(() => {
      const t = (window as any).readingInkTest;
      const paths = [...t.container.querySelectorAll('.reading-ink path')].map((p: any) => ({
        d: p.getAttribute('d'),
        fill: p.getAttribute('fill'),
        opacity: p.getAttribute('opacity'),
      }));
      return {
        paths,
        target: t.fixture.path(t.current.strokes.find((s: any) => s.id === 'ink-update-0')),
      };
    });
  const before = await state();
  expect(before.paths[0]).toMatchObject({ d: before.target, fill: '#112233', opacity: '1' });
  // Same ID, new immutable stroke: a cache must not keep the old geometry/style.
  await page.evaluate(() => {
    const t = (window as any).readingInkTest,
      first = t.current.strokes[0];
    t.modified = {
      ...first,
      color: '#de3163',
      size: 12,
      tool: 'highlighter',
      points: first.points.map((p: number[]) => [p[0], p[1] + 18, p[2]]),
    };
    t.current = { ...t.current, strokes: [t.modified, ...t.current.strokes.slice(1)] };
    t.fixture.update(t.current);
  });
  const changed = await state();
  expect(changed.target).not.toBe(before.target);
  expect(changed.paths.some((p) => p.d === before.target)).toBe(false);
  expect(changed.paths[0]).toMatchObject({ d: changed.target, fill: '#de3163', opacity: '0.28' });
  await page.evaluate(() => {
    const t = (window as any).readingInkTest;
    t.current = {
      ...t.current,
      strokes: [t.current.strokes[1], t.modified, ...t.current.strokes.slice(2)],
    };
    t.fixture.update(t.current);
  });
  expect((await state()).paths[1].d).toBe(changed.target);
  await page.evaluate(() => {
    const t = (window as any).readingInkTest;
    t.current = {
      ...t.current,
      strokes: t.current.strokes.filter((s: any) => s.id !== t.modified.id),
    };
    t.fixture.update(t.current);
  });
  await expect(layer.locator(`path[d="${changed.target}"]`)).toHaveCount(0);
  await page.evaluate(() => {
    const t = (window as any).readingInkTest;
    t.current = { ...t.current, strokes: [t.modified, ...t.current.strokes] };
    t.fixture.update(t.current);
    t.container.querySelector('[data-ink-fixture-viewport]').scrollTop = 1300;
  });
  await expect(layer.locator(`path[d="${changed.target}"]`)).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).readingInkTest.container.querySelector(
      '[data-ink-fixture-viewport]',
    ).scrollTop = 0;
  });
  await expect(layer.locator(`path[d="${changed.target}"]`)).toHaveCount(1);
  expect((await state()).paths[0]).toMatchObject({
    d: changed.target,
    fill: '#de3163',
    opacity: '0.28',
  });
  await page.evaluate(() => {
    const t = (window as any).readingInkTest;
    t.fixture.unmount();
    t.current = t.original;
    t.fixture = t.mountReadingInk(t.container, t.original);
  });
  expect((await state()).paths[0]).toMatchObject({
    d: before.target,
    fill: '#112233',
    opacity: '1',
  });
  await page.evaluate(() => {
    const t = (window as any).readingInkTest;
    t.fixture.unmount();
    // Keep stroke keys alive while releasing their mounted owners. A global
    // element WeakMap would retain owners through still-live document strokes.
    (window as any).readingInkKeys = t.original;
    const roots = [];
    for (let n = 0; n < 12; n++) {
      const mounted = t.mountReadingInk(t.container, t.original);
      roots.push(new WeakRef(t.container.querySelector('.page-editor')));
      mounted.unmount();
    }
    (window as any).readingInkReleasedRoots = roots;
    t.container.remove();
    delete (window as any).readingInkTest;
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  expect(
    await page.evaluate(
      () =>
        (window as any).readingInkReleasedRoots.filter((ref: WeakRef<Element>) => ref.deref())
          .length,
    ),
  ).toBe(0);
  await cdp.detach();
  await page.evaluate(() => {
    delete (window as any).readingInkKeys;
    delete (window as any).readingInkReleasedRoots;
  });
  expect(errors).toEqual([]);
});
