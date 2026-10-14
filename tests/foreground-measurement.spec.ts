import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

test('shared foreground geometry stays current before paint, across resize, disable and teardown', async ({
  page,
}, info) => {
  // Isolate the production hook with eight independently clipped pages. Geometry
  // comes from real browser layout; the oracle never calls foregroundClip.
  await page.goto('/');
  await page.setContent('<div id="geometry-test"></div>');
  const reference = process.env.TIXTAB_GEOMETRY_REFERENCE;
  const expectedShared = process.env.TIXTAB_GEOMETRY_EXPECT_SHARED;
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React, {useRef, useLayoutEffect} from 'react';
        import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom';
        import {useForegroundViewport} from './src/useForegroundViewport';
        const state = window.geometryState = {reads: {view: 0, paper: 0}, clips: {}};
        const original = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.dataset.geometry) state.reads[this.dataset.geometry]++;
          return original.call(this);
        };
        function Paper({index, viewport, enabled, width}) {
          const root = useRef(null);
          const clip = useForegroundViewport(root, viewport, width, 1000, width, enabled);
          useLayoutEffect(() => {state.clips[index] = clip;});
          return <div ref={root} data-geometry="paper" data-page={index}
            style={{width, height:1000, position:'relative', flexShrink:0}}/>;
        }
        function View({enabled, width, count}) {
          const viewport = useRef(null);
          return <div ref={viewport} data-geometry="view"
            style={{width:700, height:420, overflow:'scroll', position:'relative'}}>
            {Array.from({length:count}, (_,index) =>
              <Paper key={index} index={index} viewport={viewport} enabled={enabled} width={width}/>)}</div>;
        }
        const root = createRoot(document.getElementById('geometry-test'));
        window.geometryRender = (props) => flushSync(() => root.render(<View {...props}/>));
        window.geometryUnmount = () => flushSync(() => root.unmount());
        window.geometryOriginalRect = original;
      `,
    },
    ...(reference
      ? {
          plugins: [
            {
              name: 'reference-hook',
              setup(b) {
                b.onLoad({ filter: /[\\/]useForegroundViewport\.ts$/ }, async () => ({
                  contents: await readFile(reference, 'utf8'),
                  loader: 'ts',
                }));
              },
            },
          ],
        }
      : {}),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const initial = await page.evaluate(async () => {
    // ReadingView mounts editors after visibility is known; the shared scroll
    // ref is already attached. Match that lifecycle rather than measuring an
    // unattached parent ref from a child's first layout effect.
    (window as any).geometryRender({ enabled: true, width: 1000, count: 0 });
    (window as any).geometryRender({ enabled: true, width: 1000, count: 8 });
    const reads = { ...(window as any).geometryState.reads };
    await new Promise(requestAnimationFrame);
    return { clips: (window as any).geometryState.clips, reads };
  });
  expect(initial.clips['0']).toBeTruthy();
  expect(initial.clips['7']).toBe(false);
  expect(initial.reads.view).toBeGreaterThan(0);
  expect(initial.reads.view).toBeLessThanOrEqual(16);
  expect(initial.reads.paper).toBe(initial.reads.view);
  if (expectedShared !== undefined)
    expect(initial.reads).toEqual(
      expectedShared === '1' ? { view: 8, paper: 8 } : { view: 16, paper: 16 },
    );
  await page.waitForTimeout(150);
  const results = [];
  for (const [top, left] of [
    [2800, 230],
    [0, 0],
    [6500, 290],
    [900, 150],
  ]) {
    const result = await page.evaluate(
      async ({ top, left }) => {
        const state = (window as any).geometryState;
        state.reads = { view: 0, paper: 0 };
        const view = document.querySelector<HTMLElement>('[data-geometry=view]')!;
        view.scrollTop = top;
        view.scrollLeft = left;
        for (let i = 0; i < 8; i++) view.dispatchEvent(new Event('scroll'));
        await new Promise(requestAnimationFrame);
        const reads = { ...state.reads };
        const rect = (window as any).geometryOriginalRect.call(view);
        const missing = [
          ...document.querySelectorAll<HTMLElement>('[data-geometry=paper]'),
        ].flatMap((p) => {
          const paper = (window as any).geometryOriginalRect.call(p);
          const clip = state.clips[p.dataset.page!];
          if (
            paper.bottom <= rect.top ||
            paper.top >= rect.bottom ||
            paper.right <= rect.left ||
            paper.left >= rect.right
          )
            return [];
          if (!clip) return [p.dataset.page];
          return clip.minX <= Math.max(0, rect.left - paper.left) &&
            clip.maxX >= Math.min(paper.width, rect.right - paper.left) &&
            clip.minY <= Math.max(0, rect.top - paper.top) &&
            clip.maxY >= Math.min(paper.height, rect.bottom - paper.top)
            ? []
            : [p.dataset.page];
        });
        return { top, left, reads, missing };
      },
      { top, left },
    );
    results.push(result);
    expect(result.missing).toEqual([]);
    expect(result.reads.paper).toBe(8);
    expect(result.reads.view).toBeGreaterThan(0);
    expect(result.reads.view).toBeLessThanOrEqual(8);
    if (expectedShared !== undefined)
      expect(result.reads.view).toBe(expectedShared === '1' ? 1 : 8);
    await page.waitForTimeout(80);
  }
  await page.evaluate(() =>
    (window as any).geometryRender({ enabled: false, width: 1000, count: 8 }),
  );
  expect(
    await page.evaluate(() =>
      Object.values((window as any).geometryState.clips).every((x) => x === undefined),
    ),
  ).toBe(true);
  await page.evaluate(() =>
    (window as any).geometryRender({ enabled: true, width: 800, count: 8 }),
  );
  await page.waitForTimeout(150);
  expect(
    await page.evaluate(() =>
      Object.values((window as any).geometryState.clips).every((x: any) => !x || x.maxX <= 800),
    ),
  ).toBe(true);
  const teardown = await page.evaluate(async () => {
    const state = (window as any).geometryState;
    const view = document.querySelector<HTMLElement>('[data-geometry=view]')!;
    view.dispatchEvent(new Event('scroll'));
    (window as any).geometryUnmount();
    state.reads = { view: 0, paper: 0 };
    await new Promise(requestAnimationFrame);
    return state.reads;
  });
  expect(teardown).toEqual({ view: 0, paper: 0 });
  await writeFile(
    info.outputPath('geometry-reads.json'),
    JSON.stringify(
      { reference: reference ?? null, expectedShared, results, initial, teardown },
      null,
      2,
    ),
  );
  await info.attach('geometry-reads.json', {
    body: JSON.stringify({ reference: reference ?? null, results, initial, teardown }, null, 2),
    contentType: 'application/json',
  });
});
