import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { waitForPerformanceSettled } from './performance-settle.mjs';
import {
  previewFixture,
  loadPreviewFixture,
  selectPreviewObjects,
  beginObjectPreview,
  finishObjectPreview,
  objectGeometry,
  previewPixels,
  hidePreviewGuides,
} from './object-preview-scenarios.mjs';

// Lifecycle/quality experiment, never a timing or energy benchmark. Compare
// every restored frame to cycle zero, rather than hiding drift in adjacent pairs.
const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    output: { type: 'string' },
    cycles: { type: 'string', default: '40' },
  },
});
if (!values.baseline || !values.candidate || !values.output)
  throw Error('Supply frozen apps and fresh output');
const cycles = Number(values.cycles);
expect(Number.isInteger(cycles) && cycles >= 1).toBe(true);
const directory = resolve(values.output);
await mkdir(directory);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fixture = await previewFixture();
const fixturePath = join(directory, 'fixture.tixtab');
await writeFile(fixturePath, fixture.bytes);
const result = {
  purpose: 'Repeated lifecycle quality; no resource/energy claim',
  policy:
    'Authored data and raster sources exact; restored screenshot channel delta <= 1/255 against cycle zero and baseline',
  quietMs: 80,
  cycles,
  fixtureSha256: sha(fixture.bytes),
  harnessSha256: sha(await readFile(new URL(import.meta.url))),
  scenarioSha256: sha(await readFile(new URL('./object-preview-scenarios.mjs', import.meta.url))),
  settleSha256: sha(await readFile(new URL('./performance-settle.mjs', import.meta.url))),
  runs: {},
  crossBuild: [],
  errors: [],
};
async function inventory(dir, prefix = '') {
  const rows = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (e.isDirectory()) rows.push(...(await inventory(join(dir, e.name), prefix + e.name + '/')));
    else if (e.isFile()) rows.push([prefix + e.name, sha(await readFile(join(dir, e.name)))]);
  }
  return rows;
}
async function sourceEvidence(page) {
  const raw = await page
    .locator('.page-editor')
    .first()
    .evaluate((root) => ({
      images: [...root.querySelectorAll('.placed-object')].map((el) => {
        const i = el.querySelector('img'),
          s = getComputedStyle(i);
        return {
          id: el.dataset.objectId,
          src: i.src,
          width: i.naturalWidth,
          height: i.naturalHeight,
          filter: s.filter,
          opacity: s.opacity,
        };
      }),
      canvases: [...root.querySelectorAll('canvas')].map((c) => {
        const copy = document.createElement('canvas');
        copy.width = c.width;
        copy.height = c.height;
        copy.getContext('2d').drawImage(c, 0, 0);
        return {
          className: c.className,
          width: c.width,
          height: c.height,
          filter: getComputedStyle(c).filter,
          png: copy.toDataURL(),
        };
      }),
      svg: [...root.querySelectorAll('svg.reading-ink')].map((s) => ({
        markup: s.outerHTML,
        filter: getComputedStyle(s).filter,
      })),
    }));
  const images = raw.images.map(({ src, ...row }) => ({ ...row, sourceSha256: sha(src) }));
  const canvases = await Promise.all(
    raw.canvases.map(async ({ png, ...row }) => ({
      ...row,
      rgbaSha256: sha(
        await sharp(Buffer.from(png.split(',')[1], 'base64'))
          .ensureAlpha()
          .raw()
          .toBuffer(),
      ),
    })),
  );
  return {
    images,
    canvases,
    svg: raw.svg,
    geometry: await objectGeometry(page),
    root: await page.locator('.page-editor').first().boundingBox(),
  };
}
async function compare(a, b) {
  const x = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const y = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(x.info).toEqual(y.info);
  let differentChannels = 0,
    maxChannelDelta = 0;
  for (let n = 0; n < x.data.length; n++) {
    const delta = Math.abs(x.data[n] - y.data[n]);
    if (delta) differentChannels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  return { differentChannels, maxChannelDelta, width: x.info.width, height: x.info.height };
}
const captures = { baseline: [], candidate: [] };
try {
  for (const label of ['baseline', 'candidate']) {
    const appDir = resolve(values[label]);
    const run = (result.runs[label] = {
      sourceManifestSha256: sha(await readFile(join(appDir, 'SOURCE-MANIFEST.json'))),
      runtime: [
        ...(await inventory(join(appDir, 'dist'), 'dist/')),
        ...(await inventory(join(appDir, 'electron'), 'electron/')),
        ['package.json', sha(await readFile(join(appDir, 'package.json')))],
      ],
      checkpoints: [],
    });
    run.runtimeSha256 = sha(JSON.stringify(run.runtime));
    const profile = await mkdtemp(join(tmpdir(), 'tixtab-cycles-'));
    const app = await electron.launch({
      args: [appDir],
      env: { ...process.env, SURFACETAB_DEV: '0', SURFACETAB_PROFILE: profile },
      timeout: 60000,
    });
    try {
      const page = await app.firstWindow();
      page.on('pageerror', (e) => result.errors.push({ label, message: String(e) }));
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
      );
      await page.addInitScript(() => {
        localStorage.setItem('tixtab.performance.enabled', 'true');
        localStorage.setItem('surfacetab.powerMode', 'quality');
        localStorage.setItem('surfacetab.renderQuality', 'high');
      });
      await page.reload();
      await loadPreviewFixture(page, fixture, fixturePath);
      await hidePreviewGuides(page);
      await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
      await selectPreviewObjects(page);
      await beginObjectPreview(page, false);
      await finishObjectPreview(page);
      await beginObjectPreview(page, true);
      await finishObjectPreview(page);
      await page.keyboard.press('Escape');
      const settle = async () => {
        await waitForPerformanceSettled(page, { quietMs: 80 });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            [...document.querySelectorAll('.placed-object img')].map((i) => i.decode()),
          );
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        });
      };
      await settle();
      expect(await page.locator('html').getAttribute('data-night')).toBe('true');
      run.visuals = await page.evaluate(() => ({
        dpr: devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        power: localStorage.getItem('surfacetab.powerMode'),
        quality: localStorage.getItem('surfacetab.renderQuality'),
      }));
      run.contain = await page.locator('.paper').evaluate((el) => getComputedStyle(el).contain);
      expect(run.contain).toBe(label === 'candidate' ? 'layout style' : 'none');
      // Await real native downloads so authored project bytes are checked too.
      await mkdir(join(directory, label));
      await app.evaluate(
        ({ BrowserWindow }, destinations) => {
          globalThis.qaCycleDownloads = [];
          BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (_, item) => {
            const record = {
              path: destinations[globalThis.qaCycleDownloads.length],
              state: 'progressing',
            };
            globalThis.qaCycleDownloads.push(record);
            item.setSavePath(record.path);
            item.once('done', (_, state) => {
              record.state = state;
            });
          });
        },
        [join(directory, label, 'saved-0.tixtab'), join(directory, label, 'saved-1.tixtab')],
      );
      async function save(n) {
        await page.keyboard.press('Control+s');
        await expect
          .poll(() => app.evaluate((_, n) => globalThis.qaCycleDownloads[n]?.state, n), {
            timeout: 30000,
          })
          .toBe('completed');
        const path = await app.evaluate((_, n) => globalThis.qaCycleDownloads[n].path, n);
        const bytes = await readFile(path);
        // A save notification overlaps the page and expires after several
        // cycles. Wait for it; comparing that UI overlay is not raster drift.
        await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10000 });
        return { sha256: sha(bytes), project: JSON.parse(bytes) };
      }
      const initialProject = await save(0);
      run.projectBeforeSha256 = initialProject.sha256;
      await settle();
      for (let n = 0; n <= cycles; n++) {
        if (n) {
          await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
          await page.getByRole('button', { name: '放大', exact: true }).click();
          await settle();
          await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
          await page.getByRole('button', { name: '双页预览', exact: true }).click();
          await page.getByRole('button', { name: '缩小', exact: true }).click();
          await settle();
          await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
          await page.getByRole('button', { name: '单页标注', exact: true }).click();
          await page.locator('.page-list [data-page-index="0"]').click();
          await page.getByRole('button', { name: '适合页面', exact: true }).click();
          await settle();
        }
        const sources = await sourceEvidence(page);
        const png = await previewPixels(page);
        const name = `${label}-cycle-${n}.png`;
        await writeFile(join(directory, name), png);
        captures[label].push(png);
        const delta = await compare(captures[label][0], png);
        const checkpoint = {
          cycle: n,
          name,
          sha256: sha(png),
          sources,
          versusInitial: delta,
          pending: await page.evaluate(() => window.tixtabPerformance.snapshot().pending),
        };
        run.checkpoints.push(checkpoint);
        expect(sources).toEqual(run.checkpoints[0].sources);
        expect(checkpoint.pending).toBe(0);
        // Collect the entire series even when the strict display bound fails;
        // an early abort cannot distinguish drift from an isolated outlier.
        checkpoint.displayBoundPass = delta.maxChannelDelta <= 1;
        if (n % 10 === 0) console.log(JSON.stringify({ label, cycle: n, ...delta }));
      }
      const finalProject = await save(1);
      run.projectAfterSha256 = finalProject.sha256;
      expect(finalProject.project).toEqual(initialProject.project);
      run.projectExact = true;
    } finally {
      await app.close();
    }
  }
  expect(result.runs.candidate.visuals).toEqual(result.runs.baseline.visuals);
  expect(result.runs.candidate.projectBeforeSha256).toBe(result.runs.baseline.projectBeforeSha256);
  for (let n = 0; n <= cycles; n++) {
    expect(result.runs.candidate.checkpoints[n].sources).toEqual(
      result.runs.baseline.checkpoints[n].sources,
    );
    const delta = { cycle: n, ...(await compare(captures.baseline[n], captures.candidate[n])) };
    result.crossBuild.push(delta);
    delta.displayBoundPass = delta.maxChannelDelta <= 1;
  }
  expect(result.errors).toEqual([]);
  result.contentPass = true;
  result.displayBoundPass =
    Object.values(result.runs).every((r) => r.checkpoints.every((c) => c.displayBoundPass)) &&
    result.crossBuild.every((c) => c.displayBoundPass);
  expect(result.displayBoundPass).toBe(true);
  result.pass = true;
} catch (e) {
  result.pass = false;
  result.failure = String(e);
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    pass: result.pass,
    checkpoints: Object.fromEntries(
      Object.entries(result.runs).map(([k, v]) => [k, v.checkpoints.length]),
    ),
    failure: result.failure,
  }),
);
