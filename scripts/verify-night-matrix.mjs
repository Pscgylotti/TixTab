import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { readPerformanceFixture } from './performance-fixture.mjs';
import { waitForPerformanceSettled } from './performance-settle.mjs';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'fixture-dir': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values['app-dir'] || !values['fixture-dir'] || !values.output)
  throw Error('Supply frozen app, fixtures and fresh output');
const output = resolve(values.output),
  assetDir = output.replace(/\.json$/, '') + '-pixels';
await mkdir(assetDir); // Refuse an existing evidence directory.
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const profile = await mkdtemp(join(tmpdir(), 'tixtab-night-matrix-'));
const app = await electron.launch({
  args: [resolve(values['app-dir'])],
  env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
  timeout: 60000,
});
const checks = [],
  errors = [],
  fixtures = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    localStorage.setItem('surfacetab.powerMode', 'quality');
    localStorage.setItem('surfacetab.renderQuality', 'high');
    localStorage.setItem('surfacetab.night', 'false');
    localStorage.setItem('tixtab.performance.enabled', 'true');
  });
  await page.reload();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  );
  const settle = () => waitForPerformanceSettled(page, { timeoutMs: 60000 });
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  const capture = async (workload, view, appearance) => {
    await settle();
    const images = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          'canvas.pdf-layer,canvas.reading-pdf,.page-thumbnail canvas,.pdf-detail-tile canvas,.original-image-content canvas',
        ),
      ).flatMap((c, index) => {
        const r = c.getBoundingClientRect(),
          style = getComputedStyle(c);
        if (
          c.width < 2 ||
          c.height < 2 ||
          style.visibility === 'hidden' ||
          style.display === 'none' ||
          r.right <= 0 ||
          r.bottom <= 0 ||
          r.left >= innerWidth ||
          r.top >= innerHeight
        )
          return [];
        const copy = document.createElement('canvas');
        copy.width = c.width;
        copy.height = c.height;
        copy.getContext('2d').drawImage(c, 0, 0);
        return [
          {
            index,
            className: c.className,
            width: c.width,
            height: c.height,
            source: c.closest('[data-pdf-source]')?.getAttribute('data-pdf-source') ?? null,
            png: copy.toDataURL('image/png').split(',')[1],
          },
        ];
      }),
    );
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      const png = Buffer.from(image.png, 'base64');
      delete image.png;
      const { data, info } = await sharp(png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(image.width);
      expect(info.height).toBe(image.height);
      const file = `${workload}-${view}-${appearance}-${image.index}.png`;
      await writeFile(join(assetDir, file), png, { flag: 'wx' });
      image.file = file;
      image.rgbaSha256 = hash(data);
      image.pngSha256 = hash(png);
    }
    checks.push({
      workload,
      view,
      appearance,
      images,
      counters: await page.evaluate(() => window.tixtabPerformance.snapshot().counters),
    });
    console.log(JSON.stringify({ workload, view, appearance, canvases: images.length }));
  };
  for (const workload of ['scanned', 'vector', 'objects']) {
    const fixture = await readPerformanceFixture(join(values['fixture-dir'], workload + '.tixtab'));
    fixtures.push(fixture.description);
    await page.locator('input[type=file]').setInputFiles({
      name: workload + '.tixtab',
      mimeType: 'application/json',
      buffer: fixture.bytes,
    });
    await settle();
    for (const [view, label] of [
      ['single', '单页标注'],
      ['continuous', '连续页面预览'],
      ['facing', '双页预览'],
    ]) {
      await click(label);
      await settle();
      if (view === 'single') {
        for (let n = 0; n < 8; n++) await click('放大');
        await settle();
      }
      await capture(workload, view, 'day');
      await click('实验性夜间模式');
      await capture(workload, view, 'night');
      await click('查看原色');
      await capture(workload, view, 'original');
      await click('实验性夜间模式');
      await settle();
    }
  }
  expect(errors).toEqual([]);
  await writeFile(
    output,
    JSON.stringify(
      {
        schema: 1,
        appDir: resolve(values['app-dir']),
        sourceManifestSha256: hash(
          await readFile(resolve(values['app-dir'], 'SOURCE-MANIFEST.json')),
        ),
        harnessSha256: hash(await readFile(new URL(import.meta.url))),
        fixtures,
        checks,
        errors,
        limits:
          'Strict decoded RGBA canvas comparison across frozen builds; canvas reads only in separate quality sessions. Not a physical pen or GPU reset test; original means whole-page original-color mode.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} finally {
  await app.close();
}
