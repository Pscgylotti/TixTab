import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('foreground binds after late parent attachment and migrates actual DOM nodes without idle work', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.setContent('<div id="lifecycle-host"></div>');
  const reference = process.env.TIXTAB_LIFECYCLE_REFERENCE;
  const source = await readFile(reference ?? 'src/useForegroundViewport.ts');
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
      import React,{useRef,useLayoutEffect} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {useForegroundViewport} from './src/useForegroundViewport';
      const host=document.getElementById('lifecycle-host');
      const makeView=()=>{const el=document.createElement('div');el.dataset.lifecycle='view';
        el.style.cssText='width:700px;height:420px;overflow:scroll;position:relative';return el;};
      let view=makeView();host.append(view);
      const holder=document.createElement('div');view.append(holder);
      const viewport={current:null};
      const state=window.lifecycleState={reads:0,clips:{},oldViews:[],oldPapers:[]};
      const original=HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect=function(){
        if(this.dataset.lifecycle) state.reads++;return original.call(this);
      };
      function Paper({index,enabled,width,tag}) {
        const root=useRef(null);
        const clip=useForegroundViewport(root,viewport,width,1000,undefined,enabled);
        useLayoutEffect(()=>{state.clips[index]=clip;});
        const Tag=tag;
        return <Tag ref={root} data-lifecycle="paper" data-index={index}
          style={{width,height:1000,position:'relative'}}/>;
      }
      function App(props) {
        // Like a host ancestor ref, attachment happens after child layout effects.
        useLayoutEffect(()=>{viewport.current=view;});
        return Array.from({length:8},(_,index)=><Paper key={index} index={index} {...props}/>);
      }
      const root=createRoot(holder);
      window.lifecycleRender=props=>flushSync(()=>root.render(<App {...props}/>));
      window.lifecycleSwap=()=>{
        const old=view;view=makeView();old.replaceWith(view);view.append(holder);
        state.oldViews.push(old);viewport.current=view;
      };
      window.lifecycleUnmount=()=>flushSync(()=>root.unmount());
      window.lifecycleOriginalRect=original;
    `,
    },
    ...(reference
      ? {
          plugins: [
            {
              name: 'reference-hook',
              setup(b) {
                b.onLoad({ filter: /[\\/]useForegroundViewport\.ts$/ }, async () => ({
                  contents: source.toString(),
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
  await page.evaluate(() =>
    (window as any).lifecycleRender({ enabled: true, width: 1000, tag: 'div' }),
  );
  // Baseline skips binding forever because its dependency is the stable ref.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Object.values((window as any).lifecycleState.clips).filter((x) => x !== undefined)
              .length,
        ),
      { timeout: 5000 },
    )
    .toBe(8);
  const checks: unknown[] = [];
  const coverage = async (label: string, top: number, left: number) => {
    const result = await page.evaluate(
      async ({ top, left, label }) => {
        const state = (window as any).lifecycleState;
        const view = document.querySelector<HTMLElement>('[data-lifecycle=view]')!;
        const original = (window as any).lifecycleOriginalRect;
        state.reads = 0;
        view.scrollTop = top;
        view.scrollLeft = left;
        view.dispatchEvent(new Event('scroll'));
        const frames = [];
        for (let frame = 0; frame < 3; frame++) {
          await new Promise(requestAnimationFrame);
          const rect = original.call(view);
          const missing = [
            ...document.querySelectorAll<HTMLElement>('[data-lifecycle=paper]'),
          ].flatMap((el) => {
            const p = original.call(el),
              clip = state.clips[el.dataset.index!];
            if (
              p.bottom <= rect.top ||
              p.top >= rect.bottom ||
              p.right <= rect.left ||
              p.left >= rect.right
            )
              return [];
            if (clip === undefined) return []; // Complete foreground is a valid first-paint fallback.
            if (!clip) return [el.dataset.index];
            return clip.minX <= Math.max(0, rect.left - p.left) &&
              clip.maxX >= Math.min(p.width, rect.right - p.left) &&
              clip.minY <= Math.max(0, rect.top - p.top) &&
              clip.maxY >= Math.min(p.height, rect.bottom - p.top)
              ? []
              : [el.dataset.index];
          });
          frames.push({ frame, missing });
        }
        return { label, top, left, frames, reads: state.reads };
      },
      { top, left, label },
    );
    expect(result.reads).toBeGreaterThan(0);
    expect(result.frames.flatMap((f) => f.missing)).toEqual([]);
    checks.push(result);
  };
  await coverage('late-parent', 2800, 230);
  await coverage('return-top', 0, 0);
  // Keep component and ref identities while the actual scroll node changes.
  await page.evaluate(() => {
    (window as any).lifecycleSwap();
    (window as any).lifecycleRender({ enabled: true, width: 1000, tag: 'div' });
  });
  await coverage('replacement-viewport', 6500, 290);
  // Replace host page nodes without changing the hook component or ref identity.
  await page.evaluate(() => {
    (window as any).lifecycleState.oldPapers.push(
      ...document.querySelectorAll('[data-lifecycle=paper]'),
    );
    (window as any).lifecycleRender({ enabled: true, width: 1000, tag: 'article' });
  });
  await coverage('replacement-paper', 900, 150);
  await page.evaluate(() =>
    (window as any).lifecycleRender({ enabled: false, width: 1000, tag: 'article' }),
  );
  expect(
    await page.evaluate(() =>
      Object.values((window as any).lifecycleState.clips).every((x) => x === undefined),
    ),
  ).toBe(true);
  await page.evaluate(() =>
    (window as any).lifecycleRender({ enabled: true, width: 800, tag: 'article' }),
  );
  await coverage('reenabled', 5200, 80);
  await page.waitForTimeout(150);
  const inactive = await page.evaluate(async () => {
    const s = (window as any).lifecycleState;
    s.reads = 0;
    for (const el of s.oldViews) el.dispatchEvent(new Event('scroll'));
    for (const el of s.oldPapers) el.style.height = '1px';
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return s.reads;
  });
  expect(inactive).toBe(0);
  const idle = await page.evaluate(async () => {
    const s = (window as any).lifecycleState;
    s.reads = 0;
    await new Promise((r) => setTimeout(r, 100));
    return s.reads;
  });
  expect(idle).toBe(0);
  const teardown = await page.evaluate(async () => {
    const s = (window as any).lifecycleState;
    const view = document.querySelector<HTMLElement>('[data-lifecycle=view]')!;
    view.dispatchEvent(new Event('scroll'));
    (window as any).lifecycleUnmount();
    s.reads = 0;
    window.dispatchEvent(new Event('resize'));
    view.dispatchEvent(new Event('scroll'));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return s.reads;
  });
  expect(teardown).toBe(0);
  await writeFile(
    info.outputPath('lifecycle.json'),
    JSON.stringify(
      {
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        checks,
        inactive,
        idle,
        teardown,
      },
      null,
      2,
    ),
  );
});
