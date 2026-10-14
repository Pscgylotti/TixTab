import { test as browserTest, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { waitForPerformanceSettled } from '../scripts/performance-settle.mjs';

const native = process.env.TIXTAB_CULLING_NATIVE === '1';
const sharp = createRequire(import.meta.url)('sharp') as typeof import('sharp');
const { PDFDocument, PDFDict, PDFRawStream, decodePDFRawStream } = createRequire(import.meta.url)(
  'pdf-lib',
) as typeof import('pdf-lib');
const test = native
  ? browserTest.extend({
      page: async ({}, use) => {
        const profile = await fs.mkdtemp(join(tmpdir(), 'tixtab-culling-'));
        const executablePath = process.env.SURFACETAB_EXECUTABLE;
        const app = await electron.launch({
          ...(executablePath
            ? { executablePath, args: [] }
            : { args: [process.env.TIXTAB_CULLING_APP_DIR || '.'] }),
          env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
          timeout: 60000,
        });
        try {
          await use(await app.firstWindow());
        } finally {
          await app.close();
        }
      },
    })
  : browserTest;

test('foreground culling preserves visible pixels, layer order, selected objects and the full project across views', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('tixtab.performance.enabled', 'true'));
  if (native) await page.reload();
  else await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const svg =
    'data:image/svg+xml;base64,' +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><rect width="100" height="80" rx="12" fill="#d15373" fill-opacity=".55"/><circle cx="50" cy="40" r="28" fill="#407bdf" fill-opacity=".7"/></svg>',
    ).toString('base64');
  const png = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = data;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 80;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    return canvas.toDataURL();
  }, svg);
  const images = Array.from({ length: 120 }, (_, i) => ({
    id: `i${i}`,
    kind: i % 2 ? 'image' : 'sketch',
    ...(i % 2 ? {} : { scene: { elements: [] } }),
    data: png,
    displayData: svg,
    x: 40 + (i % 8) * 240,
    y: 40 + Math.floor(i / 8) * 190,
    width: 150,
    height: 120,
  }));
  const strokes = Array.from({ length: 600 }, (_, i) => ({
    id: `s${i}`,
    tool: i % 2 ? 'highlighter' : 'pen',
    color: '#2757b0',
    size: i % 2 ? 30 : 4,
    points: [
      [(i % 10) * 190 + 15, Math.floor(i / 10) * 48, 0.4],
      [(i % 10) * 190 + 175, Math.floor(i / 10) * 48 + 55, 0.8],
    ],
  }));
  const notebook = {
    version: 1,
    name: 'Culling fixture',
    source: null,
    pages: [
      {
        id: 'foreground',
        width: 2000,
        height: 3000,
        sourceIndex: null,
        paper: 'plain',
        images,
        strokes,
        inkLayer: 60,
      },
    ],
  };
  await page.locator('input[type=file][accept=".pdf,.tixtab"]').setInputFiles({
    name: 'culling.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(notebook)),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.addStyleTag({
    content: '* { transition: none !important; animation: none !important; }',
  });
  await page.evaluate((value) => {
    (window as any).cullingFixture = value;
  }, notebook.pages[0]);
  // The same independent geometry oracle runs against Vite and the real packaged
  // app. Only this test module is injected; production rendering is unchanged.
  const oracle = await build({
    stdin: {
      contents: `export { inkBounds, finalInkPath } from './src/ink'; export { groupDisplay } from './src/objectGroup'; export { isPicture } from './src/model';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  await page.evaluate(
    async (data) => {
      (window as any).cullingOracle = await import(data);
    },
    'data:text/javascript;base64,' + Buffer.from(oracle.outputFiles[0].contents).toString('base64'),
  );
  const comparisons: unknown[] = [];
  // The oracle temporarily mounts every original object/path at its original z-index.
  const compare = async () => {
    await waitForPerformanceSettled(page);
    const viewport = page.locator('.surface,.reading-view');
    const stableScreenshot = async () => {
      let previous = await viewport.screenshot();
      const first = previous;
      for (let n = 0; n < 8; n++) {
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        const current = await viewport.screenshot();
        if (current.equals(previous)) return current;
        // Native GPU captures can toggle the last 8-bit channel step even for
        // an unchanged scene. Use the same explicit bound as the final oracle;
        // larger differences must settle, never get hidden by this check.
        const [a, b] = await Promise.all(
          [current, previous].map((bytes) => sharp(bytes).ensureAlpha().raw().toBuffer()),
        );
        if (a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= 1))
          return current;
        previous = current;
      }
      await fs.writeFile(testInfo.outputPath('unstable-first.png'), first);
      await fs.writeFile(testInfo.outputPath('unstable-last.png'), previous);
      throw Error('Foreground pixels did not settle before comparison');
    };
    await expect.poll(() => page.locator('.placed-object').count()).toBeGreaterThan(0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.querySelectorAll<HTMLImageElement>('.placed-object img')].map((i) =>
          i.decode(),
        ),
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    const geometry = await page.evaluate(async () => {
      const { inkBounds, finalInkPath } = (window as any).cullingOracle;
      const p = (window as any).cullingFixture;
      const view = document.querySelector('.surface,.reading-view')!.getBoundingClientRect();
      const paper = document.querySelector('.page-editor')!.getBoundingClientRect();
      const sx = paper.width / p.width,
        sy = paper.height / p.height;
      const intersects = (x: number, y: number, width: number, height: number) =>
        paper.left + (x + width) * sx > view.left &&
        paper.left + x * sx < view.right &&
        paper.top + (y + height) * sy > view.top &&
        paper.top + y * sy < view.bottom;
      const objects = new Map(
        [...document.querySelectorAll<HTMLElement>('.placed-object')].map((node) => [
          node.dataset.objectId,
          node,
        ]),
      );
      const missingObjects = p.images
        .filter((i: any) => intersects(i.x, i.y, i.width, i.height) && !objects.has(i.id))
        .map((i: any) => i.id);
      const badLayers = p.images
        .filter(
          (i: any, n: number) =>
            objects.has(i.id) && objects.get(i.id)!.style.zIndex !== String(n * 2 + 2),
        )
        .map((i: any) => i.id);
      const ink = document.querySelector('.reading-ink');
      const paths = new Set([...(ink?.children ?? [])].map((node) => node.getAttribute('d')));
      const missingInk = ink
        ? p.strokes
            .filter((s: any) => {
              const b = inkBounds(s);
              return (
                intersects(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY) &&
                !paths.has(finalInkPath(s))
              );
            })
            .map((s: any) => s.id)
        : [];
      const order = new Map(p.strokes.map((s: any, n: number) => [finalInkPath(s), n]));
      const renderedOrder = [...(ink?.children ?? [])].map(
        (node) => order.get(node.getAttribute('d')) as number,
      );
      return {
        missingObjects,
        badLayers,
        missingInk,
        inkOrderCorrect: renderedOrder.every((n, i) => !i || n > renderedOrder[i - 1]),
      };
    });
    expect(geometry).toEqual({
      missingObjects: [],
      badLayers: [],
      missingInk: [],
      inkOrderCorrect: true,
    });
    await page.evaluate(async () => {
      const { finalInkPath, groupDisplay, isPicture } = (window as any).cullingOracle;
      const pdfNight =
        document
          .querySelector('.page-editor')!
          .closest('[data-pdf-night]')
          ?.getAttribute('data-pdf-night') === 'true';
      const p = (window as any).cullingFixture,
        layer = document.querySelector('.object-layer')!;
      (window as any).restoreForeground = [[layer, [...layer.childNodes]]];
      const nodes = p.images.map((i: any, n: number) => {
        const existing = layer.querySelector<HTMLDivElement>(`[data-object-id="${i.id}"]`);
        if (existing) return existing;
        const host = document.createElement('div');
        host.className = 'placed-object';
        host.style.cssText = `left:${i.x}px;top:${i.y}px;width:${i.width}px;height:${i.height}px;z-index:${n * 2 + 2}`;
        const image = new Image();
        image.dataset.nightInk = String(!isPicture(i));
        image.src = groupDisplay(i, document.documentElement.dataset.night === 'true', pdfNight);
        host.append(image);
        return host;
      });
      // Preserve existing image nodes and their raster caches; add only culled content.
      for (const node of nodes) if (!node.parentNode) layer.append(node);
      const ink = document.querySelector('.reading-ink');
      if (ink) {
        (window as any).restoreForeground.push([ink, [...ink.childNodes]]);
        const existing = new Map([...ink.children].map((path) => [path.getAttribute('d'), path]));
        let previous: Element | null = null;
        for (const s of p.strokes) {
          const d = finalInkPath(s);
          const retained = existing.get(d);
          if (retained) {
            previous = retained;
            continue;
          }
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('fill', s.color);
          path.setAttribute(
            'opacity',
            String(s.tool === 'highlighter' ? 0.28 : s.tool === 'pencil' ? 0.65 : 1),
          );
          ink.insertBefore(path, previous ? previous.nextSibling : ink.firstChild);
          previous = path;
        }
      }
      await Promise.all(
        nodes.map((node: HTMLDivElement) => (node.firstChild as HTMLImageElement).decode()),
      );
      (window as any).foregroundDebug = {
        layer,
        addedObjects: nodes.filter(
          (node: Node) => !(window as any).restoreForeground[0][1].includes(node),
        ),
        ink,
        allInk: ink ? [...ink.childNodes] : [],
      };
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    const full = await stableScreenshot();
    await page.evaluate(() => {
      for (const [el, children] of (window as any).restoreForeground)
        for (const child of [...el.childNodes]) if (!children.includes(child)) child.remove();
      delete (window as any).restoreForeground;
    });
    // Both captures share the same warmed image raster caches. The reference
    // must not create different SVG cache residency only after the candidate capture.
    const before = await stableScreenshot();
    const difference = await page.evaluate(
      async ([a, b]) => {
        const pixels = async (data: string) => {
          const image = new Image();
          image.src = data;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const [first, second] = await Promise.all([pixels(a), pixels(b)]);
        let maximum = 0,
          changed = 0,
          overOne = 0;
        for (let n = 0; n < first.length; n += 4) {
          const delta = Math.max(
            ...[0, 1, 2, 3].map((k) => Math.abs(first[n + k] - second[n + k])),
          );
          maximum = Math.max(maximum, delta);
          if (delta) changed++;
          if (delta > 1) overOne++;
        }
        return {
          maximum,
          changed,
          overOne,
          night: document.documentElement.dataset.night,
          reading: !!document.querySelector('.reading-ink'),
        };
      },
      [before, full].map((bytes) => 'data:image/png;base64,' + bytes.toString('base64')),
    );
    comparisons.push(difference);
    if (difference.overOne) {
      await fs.writeFile(testInfo.outputPath('culled.png'), before);
      await fs.writeFile(testInfo.outputPath('full.png'), full);
      await fs.writeFile(testInfo.outputPath('difference.json'), JSON.stringify(difference));
      await page.evaluate(() => {
        const debug = (window as any).foregroundDebug;
        debug.addedObjects.forEach((node: Node) => debug.layer.append(node));
      });
      await fs.writeFile(testInfo.outputPath('full-objects-only.png'), await stableScreenshot());
      await page.evaluate(() => {
        const debug = (window as any).foregroundDebug;
        debug.addedObjects.forEach((node: Element) => node.remove());
        if (debug.ink) debug.allInk.forEach((node: Node) => debug.ink.append(node));
      });
      await fs.writeFile(testInfo.outputPath('full-ink-only.png'), await stableScreenshot());
    }
    expect(difference.overOne, JSON.stringify(difference)).toBe(0);
    expect(await page.locator('.placed-object').count()).toBeLessThan(images.length);
  };
  for (const night of process.env.TIXTAB_TRANSIENT_ONLY ? [] : [false, true]) {
    if (night) await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    for (const view of ['单页标注', '连续页面预览', '双页预览']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      // Raise zoom enough that most of the large page is offscreen, retaining normal quality.
      for (let i = 0; i < 12; i++)
        await page.getByRole('button', { name: '放大', exact: true }).click();
      await compare();
      if (view !== '单页标注') {
        const layer = page.locator('.reading-ink');
        expect(Number(await layer.getAttribute('data-visible-strokes'))).toBeLessThan(
          strokes.length,
        );
        await page.locator('.reading-view').evaluate((el) => {
          el.scrollTop += 650;
          el.scrollLeft += 250;
        });
        await compare();
      }
    }
  }
  await fs.writeFile(
    testInfo.outputPath('pixel-comparisons.json'),
    JSON.stringify(comparisons, null, 2),
  );
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  for (let i = 0; i < 12; i++)
    await page.getByRole('button', { name: '放大', exact: true }).click();
  await waitForPerformanceSettled(page);
  const transient = await page.evaluate(async () => {
    const { inkBounds, finalInkPath } = (window as any).cullingOracle;
    const p = (window as any).cullingFixture;
    const strokes = p.strokes.map((s: any) => ({ bounds: inkBounds(s), path: finalInkPath(s) }));
    const view = document.querySelector<HTMLElement>('.reading-view')!;
    const results: { step: number; frame: number; missingObjects: string[]; missingInk: number }[] =
      [];
    for (let step = 0; step < 16; step++) {
      view.scrollTop = (step * 977) % (view.scrollHeight - view.clientHeight);
      view.scrollLeft = (step * 397) % Math.max(1, view.scrollWidth - view.clientWidth);
      // Dispatch in the same task to exercise the earliest scheduled measurement.
      view.dispatchEvent(new Event('scroll'));
      for (let frame = 0; frame < 3; frame++) {
        await new Promise(requestAnimationFrame);
        const paper = document.querySelector('.page-editor')!.getBoundingClientRect();
        const rect = view.getBoundingClientRect();
        const sx = paper.width / p.width,
          sy = paper.height / p.height;
        const intersects = (x: number, y: number, width: number, height: number) =>
          paper.left + (x + width) * sx > rect.left &&
          paper.left + x * sx < rect.right &&
          paper.top + (y + height) * sy > rect.top &&
          paper.top + y * sy < rect.bottom;
        const mounted = new Set(
          [...document.querySelectorAll<HTMLElement>('.placed-object')].map(
            (el) => el.dataset.objectId,
          ),
        );
        const paths = new Set(
          [...document.querySelectorAll('.reading-ink path')].map((el) => el.getAttribute('d')),
        );
        results.push({
          step,
          frame,
          missingObjects: p.images
            .filter((i: any) => intersects(i.x, i.y, i.width, i.height) && !mounted.has(i.id))
            .map((i: any) => i.id),
          missingInk: strokes.filter(
            (s: any) =>
              intersects(
                s.bounds.minX,
                s.bounds.minY,
                s.bounds.maxX - s.bounds.minX,
                s.bounds.maxY - s.bounds.minY,
              ) && !paths.has(s.path),
          ).length,
        });
      }
    }
    return results;
  });
  await fs.writeFile(
    testInfo.outputPath('transient-coverage.json'),
    JSON.stringify(transient, null, 2),
  );
  expect(transient.filter((result) => result.missingObjects.length || result.missingInk)).toEqual(
    [],
  );
  await page.getByRole('button', { name: '对象', exact: true }).click();
  const chosen = page.locator('.placed-object').first();
  const chosenId = await chosen.getAttribute('data-object-id');
  await chosen.click();
  await expect(page.locator('.placed-object.chosen')).toHaveCount(1);
  await page.locator('.reading-view').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator(`.placed-object.chosen[data-object-id="${chosenId}"]`)).toHaveCount(1);
  let saved;
  if (native) {
    // Inspect the actual encoder output, without opening a Windows Save dialog.
    saved = await page.evaluate(async () => {
      const create = URL.createObjectURL,
        click = HTMLAnchorElement.prototype.click;
      let blob: Blob | undefined;
      URL.createObjectURL = (value) => {
        if (value instanceof Blob) blob = value;
        return create(value);
      };
      HTMLAnchorElement.prototype.click = () => {};
      try {
        document.querySelector<HTMLButtonElement>('button[aria-label="保存工程"]')!.click();
        if (!blob) throw Error('Project encoder did not produce a Blob');
        return JSON.parse(await blob.text());
      } finally {
        URL.createObjectURL = create;
        HTMLAnchorElement.prototype.click = click;
      }
    });
  } else {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存工程', exact: true }).click();
    saved = JSON.parse(await fs.readFile((await (await download).path())!, 'utf8'));
  }
  expect(saved.pages[0]).toEqual(notebook.pages[0]);
  // Exercise the real asynchronous export worker while most foreground nodes
  // are culled. Inspect the final PDF appearance, not a copied test projection.
  let exported: Buffer;
  if (native) {
    await page.evaluate(() => {
      const state = {
        create: URL.createObjectURL,
        click: HTMLAnchorElement.prototype.click,
        blob: undefined as Blob | undefined,
      };
      (window as any).cullingExport = state;
      URL.createObjectURL = (value) => {
        if (value instanceof Blob && value.type === 'application/pdf') state.blob = value;
        return state.create(value);
      };
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download.endsWith('.pdf')) state.click.call(this);
      };
    });
    try {
      await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
      await page.waitForFunction(() => !!(window as any).cullingExport.blob);
      exported = Buffer.from(
        await page.evaluate(async () =>
          Array.from(new Uint8Array(await (window as any).cullingExport.blob.arrayBuffer())),
        ),
      );
    } finally {
      await page.evaluate(() => {
        URL.createObjectURL = (window as any).cullingExport.create;
        HTMLAnchorElement.prototype.click = (window as any).cullingExport.click;
        delete (window as any).cullingExport;
      });
    }
  } else {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
    exported = await fs.readFile((await (await downloaded).path())!);
  }
  await fs.writeFile(testInfo.outputPath('full-foreground.pdf'), exported);
  const doc = await PDFDocument.load(exported);
  expect(doc.getPageCount()).toBe(1);
  const annotation = doc.context.lookup(doc.getPage(0).node.Annots()!.get(0), PDFDict);
  const appearance = annotation
    .lookup(doc.context.obj('AP'), PDFDict)
    .lookup(doc.context.obj('N'), PDFRawStream);
  const operations = Buffer.from(decodePDFRawStream(appearance).decode())
    .toString('ascii')
    .trim()
    .split('\n');
  const imageAt = operations.flatMap((op, index) => (/ Do$/.test(op) ? [index] : []));
  const inkAt = operations.flatMap((op, index) => (op === 'f' ? [index] : []));
  expect(imageAt).toHaveLength(images.length);
  expect(inkAt).toHaveLength(strokes.length);
  expect(imageAt[59]).toBeLessThan(inkAt[0]);
  expect(imageAt[60]).toBeGreaterThan(inkAt.at(-1)!);
  // pdf-lib emits translation and scale as separate matrices.
  expect(operations).toContain('1 0 0 1 1720 180 cm');
  expect(operations).toContain('150 0 0 120 0 0 cm');
});
