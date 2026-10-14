import { test as browserTest, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { waitForPerformanceSettled } from '../scripts/performance-settle.mjs';

const native = process.env.TIXTAB_BITMAP_NATIVE === '1';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const test = native
  ? browserTest.extend({
      page: async ({}, use) => {
        const profile = await mkdtemp(join(tmpdir(), 'tixtab-bitmap-'));
        const app = await electron.launch({
          args: [process.env.TIXTAB_BITMAP_APP_DIR || '.'],
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

test.afterEach(async ({}, info) => {
  const sourceFiles = [
    'pdfBitmapDisplay.ts',
    'usePdfBitmapDisplay.ts',
    'pdfRenderCache.ts',
    'PdfSurface.tsx',
    'ReadingView.tsx',
    'PdfDetailLayer.tsx',
    'PageThumbnail.tsx',
    'night.css',
  ];
  const sources = await Promise.all(
    sourceFiles.map(async (name) => [name, hash(await readFile('src/' + name))]),
  );
  const appDir = native ? resolve(process.env.TIXTAB_BITMAP_APP_DIR || '.') : null;
  const runtime: [string, string][] = [];
  async function inventory(directory: string, prefix: string) {
    for (const e of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(directory, e.name),
        name = prefix + e.name;
      if (e.isDirectory()) await inventory(file, name + '/');
      else if (e.isFile()) runtime.push([name, hash(await readFile(file))]);
    }
  }
  if (appDir) {
    await inventory(join(appDir, 'dist'), 'dist/');
    await inventory(join(appDir, 'electron'), 'electron/');
    runtime.push(['package.json', hash(await readFile(join(appDir, 'package.json')))]);
  }
  await writeFile(
    info.outputPath('binding.json'),
    JSON.stringify(
      {
        native,
        appDir,
        sources,
        runtime,
        runtimeSha256: hash(JSON.stringify(runtime)),
        sourceManifestSha256: appDir
          ? hash(await readFile(join(appDir, 'SOURCE-MANIFEST.json')))
          : null,
        testSha256: hash(await readFile(new URL(import.meta.url))),
        limits:
          'Synthetic contextlost dispatch tests invalidation and recovery. It is not a real GPU reset. Isolated ownership uses a fake raster producer; actual-PDF tests exercise the running application.',
      },
      null,
      2,
    ),
  );
});

test('immutable display ownership, concurrent fallback, eviction, loss and teardown', async ({
  page,
}, info) => {
  if (!native) await page.goto('/');
  await page.setContent('<div id="bitmap-test"></div>');
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `export { PdfBitmapDisplay } from './src/pdfBitmapDisplay';
        export { requestPdfBitmap, getPdfRenderStats, priorPdfBitmap, releasePdfRenderCache } from './src/pdfRenderCache';`,
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'bitmapTest',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const {
      PdfBitmapDisplay,
      requestPdfBitmap,
      getPdfRenderStats,
      priorPdfBitmap,
      releasePdfRenderCache,
    } = (window as any).bitmapTest;
    const checks: string[] = [];
    const check = (name: string, valid: boolean) => {
      if (!valid) throw Error(name);
      checks.push(name);
    };
    const root = document.getElementById('bitmap-test')!;
    const host = () => root.appendChild(document.createElement('div'));
    const pdf = (width = 200, height = 300) => ({
      getPage: async (page: number) => ({
        getViewport: () => ({ width, height }),
        render: ({ canvasContext: ctx }: any) => {
          ctx.fillStyle = page % 2 ? '#ce4768' : '#357acb';
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = '#fff';
          ctx.fillText('Immutable raster ' + page, 10, 30);
          return { promise: Promise.resolve(), cancel() {} };
        },
      }),
    });
    const p = pdf();
    const source = await requestPdfBitmap(p, 0, 1).promise;
    const pixels = source.toDataURL();
    let copies = 0;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      copies++;
      return (original as any).apply(this, args);
    } as typeof original;
    let recoveries = 0;
    const aHost = host(),
      bHost = host(),
      cHost = host();
    const a = new PdfBitmapDisplay(aHost, 'reading-pdf', () => recoveries++);
    const b = new PdfBitmapDisplay(bHost, 'pdf-layer', () => recoveries++);
    const c = new PdfBitmapDisplay(cHost, 'reading-pdf', () => recoveries++);
    a.show(source, false);
    check(
      'first display borrows the original without a copy',
      aHost.firstChild === source && copies === 0,
    );
    a.show(source, false);
    check(
      'repeated same raster does not copy or remount',
      aHost.firstChild === source && copies === 0,
    );
    b.show(source, false);
    const fallback = bHost.firstChild as HTMLCanvasElement;
    check(
      'concurrent view copies and never steals the original',
      aHost.firstChild === source && fallback !== source && copies === 1,
    );
    check('fallback pixels are identical', fallback.toDataURL() === pixels);
    b.clear();
    check(
      'fallback clear preserves source dimensions and pixels',
      source.width === 200 && source.height === 300 && source.toDataURL() === pixels,
    );
    a.clear();
    c.show(source, false);
    a.dispose();
    check(
      'released original can be borrowed by another view',
      cHost.firstChild === source && copies === 1,
    );
    check(
      'stale owner disposal cannot detach a new owner',
      source.parentNode === cHost && source.toDataURL() === pixels,
    );
    b.show(source, false);
    const clone = bHost.firstChild as HTMLCanvasElement;
    clone.dispatchEvent(new Event('contextlost'));
    check(
      'fallback loss requests recovery without invalidating source',
      recoveries === 1 && priorPdfBitmap(p, 0) === source && source.parentNode === cHost,
    );
    b.show(source, false);
    const beforeLossCopies = copies;
    source.getContext('2d')!.clearRect(0, 0, 200, 300);
    source.dispatchEvent(new Event('contextlost'));
    check(
      'source loss clears owner and invalidates cache',
      recoveries === 2 &&
        !priorPdfBitmap(p, 0) &&
        getPdfRenderStats(p).bytes === 0 &&
        (cHost.firstChild as HTMLCanvasElement).width === 1,
    );
    const restored = await requestPdfBitmap(p, 0, 1).promise;
    c.show(restored, false);
    check(
      'recovery rerenders and restores identical pixels',
      restored !== source && restored.toDataURL() === pixels && copies === beforeLossCopies,
    );
    c.dispose();
    restored.dispatchEvent(new Event('contextlost'));
    check(
      'unmounted display does not receive recovery callbacks',
      recoveries === 2 && !cHost.childNodes.length,
    );
    const external = document.createElement('canvas');
    external.width = external.height = 10;
    const externalHost = host();
    externalHost.appendChild(external);
    b.show(external, true);
    check(
      'unknown DOM owner is never stolen and palette metadata is current',
      external.parentNode === externalHost &&
        (bHost.firstChild as HTMLElement).dataset.renderedNight === 'true',
    );
    b.dispose();
    b.show(external, false);
    check('late results after disposal cannot remount', !bHost.childNodes.length);
    const large = pdf(3000, 2000),
      eHost = host();
    const e = new PdfBitmapDisplay(eHost, 'pdf-layer', () => recoveries++);
    const first = await requestPdfBitmap(large, 0, 1).promise;
    e.show(first, false);
    const sample = () =>
      Array.from(first.getContext('2d')!.getImageData(0, 0, 1, 1).data).join(',');
    const before = sample();
    await requestPdfBitmap(large, 1, 1).promise;
    await requestPdfBitmap(large, 2, 1).promise;
    check(
      'minimum page retention preserves three rendered pages',
      getPdfRenderStats(large).bytes === 72000000 && priorPdfBitmap(large, 0) === first,
    );
    releasePdfRenderCache(large);
    check(
      'document retirement preserves a mounted original raster',
      getPdfRenderStats(large).bytes === 0 &&
        !priorPdfBitmap(large, 0) &&
        first.parentNode === eHost &&
        sample() === before,
    );
    e.clear();
    check(
      'retired display releases its pixel buffer on unmount',
      first.width === 1 && first.height === 1,
    );
    const rerendered = await requestPdfBitmap(large, 0, 1).promise;
    check(
      'return to an evicted page rerenders a new complete raster',
      rerendered !== first && rerendered.width === 3000 && getPdfRenderStats(large).renders === 4,
    );
    e.dispose();
    CanvasRenderingContext2D.prototype.drawImage = original;
    return { checks, recoveries, copies };
  });
  expect(result.checks).toHaveLength(17);
  await writeFile(info.outputPath('ownership.json'), JSON.stringify(result, null, 2));
});

test('actual PDF displays recover after loss in each view and palette without poisoning cache', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('tixtab.performance.enabled', 'true');
    localStorage.setItem('surfacetab.renderQuality', 'high');
    localStorage.setItem('surfacetab.powerMode', 'quality');
  });
  if (native) await page.reload();
  else await page.goto('/');
  await waitForPerformanceSettled(page);
  const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const p = pdf.addPage([595, 842]);
    p.drawText('Canvas ownership page ' + (i + 1), { x: 40, y: 730, size: 22, font });
  }
  await page.locator('input[type=file]').setInputFiles({
    name: 'ownership.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await waitForPerformanceSettled(page);
  const observations = [];
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await waitForPerformanceSettled(page);
    for (const night of [false, true]) {
      if (night) {
        await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
        await waitForPerformanceSettled(page);
      }
      const selector = view === '单页标注' ? 'canvas.pdf-layer' : 'canvas.reading-pdf';
      const image = await page
        .locator(selector)
        .first()
        .evaluate((el: HTMLCanvasElement) => {
          const png = el.toDataURL();
          const width = el.width,
            height = el.height;
          (window as any).lostBitmap = el;
          el.getContext('2d')!.clearRect(0, 0, el.width, el.height);
          el.dispatchEvent(new Event('contextlost'));
          return { png, width, height };
        });
      await waitForPerformanceSettled(page);
      const restored = await page
        .locator(selector)
        .first()
        .evaluate((el: HTMLCanvasElement) => ({
          png: el.toDataURL(),
          width: el.width,
          height: el.height,
          replaced: el !== (window as any).lostBitmap,
          night: el.dataset.renderedNight,
        }));
      expect(restored).toMatchObject({ ...image, replaced: true, night: String(night) });
      observations.push({
        view,
        night,
        width: restored.width,
        height: restored.height,
        replaced: restored.replaced,
      });
    }
    await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await waitForPerformanceSettled(page);
  }
  await writeFile(info.outputPath('recovery.json'), JSON.stringify(observations, null, 2));
});

test('actual thumbnails and high-resolution tiles recover independently', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('tixtab.performance.enabled', 'true');
    localStorage.setItem('surfacetab.renderQuality', 'high');
    localStorage.setItem('surfacetab.powerMode', 'quality');
  });
  if (native) await page.reload();
  else await page.goto('/');
  await waitForPerformanceSettled(page);
  const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([595, 842]);
  p.drawText('Tile and thumbnail recovery', { x: 40, y: 730, size: 22, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'tile-recovery.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await waitForPerformanceSettled(page);
  await page.locator('.surface').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const current = el.querySelector('.paper')!.getBoundingClientRect().width / 595;
    el.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -Math.log(3.5 / current) / 0.008,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
  });
  await waitForPerformanceSettled(page);
  const observations = [];
  for (const night of [false, true]) {
    if (night) {
      await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
      await waitForPerformanceSettled(page);
    }
    for (const selector of ['.page-thumbnail canvas', '.pdf-detail-tile[data-ready=true] canvas']) {
      const selected = page.locator(selector).first();
      await expect(selected).toBeVisible();
      const before = await selected.evaluate((el: HTMLCanvasElement) => {
        (window as any).lostBitmap = el;
        const result = { png: el.toDataURL(), width: el.width, height: el.height };
        el.getContext('2d')!.clearRect(0, 0, el.width, el.height);
        el.dispatchEvent(new Event('contextlost'));
        return result;
      });
      await waitForPerformanceSettled(page);
      const after = await page
        .locator(selector)
        .first()
        .evaluate((el: HTMLCanvasElement) => ({
          png: el.toDataURL(),
          width: el.width,
          height: el.height,
          replaced: el !== (window as any).lostBitmap,
          night: el.dataset.renderedNight,
        }));
      expect(after).toMatchObject({ ...before, replaced: true, night: String(night) });
      observations.push({
        selector,
        night,
        width: after.width,
        height: after.height,
        replaced: after.replaced,
      });
    }
  }
  await writeFile(
    info.outputPath('tile-thumbnail-recovery.json'),
    JSON.stringify(observations, null, 2),
  );
});
