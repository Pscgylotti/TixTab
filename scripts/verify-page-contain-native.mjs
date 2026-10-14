import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import {
  previewFixture,
  loadPreviewFixture,
  previewReady,
  selectPreviewObjects,
  beginObjectPreview,
  finishObjectPreview,
  objectGeometry,
  previewPixels,
  hidePreviewGuides,
} from './object-preview-scenarios.mjs';
const sharp = createRequire(import.meta.url)('sharp');
const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    output: { type: 'string' },
    'show-guides': { type: 'boolean', default: false },
    'candidate-contain': { type: 'string', default: 'layout style' },
    quality: { type: 'string', default: 'high' },
  },
});
if (!values.baseline || !values.candidate || !values.output)
  throw Error('Supply frozen baseline/candidate app dirs and fresh output');
expect(['standard', 'high', 'ultra']).toContain(values.quality);
const destination = resolve(values.output);
await mkdir(destination);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = await previewFixture();
await writeFile(join(destination, 'fixture.tixtab'), fixture.bytes);
const result = {
  fixtureSha256: sha(fixture.bytes),
  sources: {},
  errors: [],
  renders: {},
  checks: [],
  previewCommit: [],
  styleChecks: {},
  visuals: {},
  quality: values.quality,
  candidateContain: values['candidate-contain'],
  guidesVisible: values['show-guides'],
};
result.harnessSha256 = sha(await readFile(new URL(import.meta.url)));
result.scenariosSha256 = sha(
  await readFile(new URL('./object-preview-scenarios.mjs', import.meta.url)),
);
const buffers = new Map();
async function inventory(directory, prefix = '') {
  const files = [];
  for (const e of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, e.name),
      name = prefix + e.name;
    if (e.isDirectory()) files.push(...(await inventory(path, name + '/')));
    else if (e.isFile()) files.push([name, sha(await readFile(path))]);
  }
  return files;
}
async function rasterEvidence(page) {
  const rows = await page
    .locator('.page-editor')
    .first()
    .locator('.placed-object')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const img = node.querySelector('img'),
          style = getComputedStyle(img),
          r = img.getBoundingClientRect();
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(r.width * devicePixelRatio);
        canvas.height = Math.ceil(r.height * devicePixelRatio);
        const ctx = canvas.getContext('2d');
        ctx.filter = style.filter;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return {
          id: node.dataset.objectId,
          source: img.src,
          filter: style.filter,
          opacity: style.opacity,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          width: canvas.width,
          height: canvas.height,
          png: canvas.toDataURL(),
        };
      }),
    );
  const objects = await Promise.all(
    rows.map(async ({ png, source, ...row }) => ({
      ...row,
      sourceSha256: sha(source),
      rgbaSha256: sha(
        await sharp(Buffer.from(png.split(',')[1], 'base64'))
          .ensureAlpha()
          .raw()
          .toBuffer(),
      ),
    })),
  );
  const ink = await page
    .locator('.page-editor')
    .first()
    .locator('canvas')
    .evaluateAll((nodes) =>
      nodes.map((c) => {
        // Read the copy, preserving the display canvas's raster backend.
        const copy = document.createElement('canvas');
        copy.width = c.width;
        copy.height = c.height;
        copy.getContext('2d').drawImage(c, 0, 0);
        return {
          className: c.className,
          width: c.width,
          height: c.height,
          png: copy.toDataURL(),
          filter: getComputedStyle(c).filter,
        };
      }),
    );
  const inkRasters = await Promise.all(
    ink.map(async ({ png, ...row }) => ({
      ...row,
      rgbaSha256: sha(
        await sharp(Buffer.from(png.split(',')[1], 'base64'))
          .ensureAlpha()
          .raw()
          .toBuffer(),
      ),
    })),
  );
  const inkSvg = await page
    .locator('.page-editor')
    .first()
    .locator('svg.reading-ink')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ markup: node.outerHTML, filter: getComputedStyle(node).filter })),
    );
  return { objects, inkRasters, inkSvg };
}
async function compare(a, b) {
  const x = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const y = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(x.info).toEqual(y.info);
  let different = 0,
    max = 0;
  for (let i = 0; i < x.data.length; i++)
    if (x.data[i] !== y.data[i]) {
      different++;
      max = Math.max(max, Math.abs(x.data[i] - y.data[i]));
    }
  return { different, max, width: x.info.width, height: x.info.height };
}
try {
  for (const label of ['baseline', 'candidate']) {
    const appDir = resolve(values[label]);
    result.sources[label] = {
      appDir,
      sourceManifestSha256: sha(await readFile(join(appDir, 'SOURCE-MANIFEST.json'))),
      runtime: [
        ...(await inventory(join(appDir, 'dist'), 'dist/')),
        ...(await inventory(join(appDir, 'electron'), 'electron/')),
        ['package.json', sha(await readFile(join(appDir, 'package.json')))],
      ],
    };
    result.sources[label].runtimeSha256 = sha(JSON.stringify(result.sources[label].runtime));
    const profile = await mkdtemp(join(tmpdir(), 'tixtab-preview-'));
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
      await page.addInitScript((quality) => {
        localStorage.setItem('tixtab.performance.enabled', 'true');
        localStorage.setItem('surfacetab.powerMode', 'quality');
        localStorage.setItem('surfacetab.renderQuality', quality);
      }, values.quality);
      await page.reload();
      await previewReady(page);
      result.visuals[label] = await page.evaluate(() => ({
        dpr: devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        power: localStorage.getItem('surfacetab.powerMode'),
        quality: localStorage.getItem('surfacetab.renderQuality'),
      }));
      if (!values['show-guides']) await hidePreviewGuides(page);
      result.renders[label] = [];
      result.styleChecks[label] = [];
      for (const night of [false, true])
        for (const [viewName, view] of [
          ['single', '单页标注'],
          ['continuous', '连续页面预览'],
          ['facing', '双页预览'],
        ]) {
          await loadPreviewFixture(page, fixture, join(destination, 'fixture.tixtab'));
          if ((await page.locator('html').getAttribute('data-night')) !== String(night))
            await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
          await page.getByRole('button', { name: view, exact: true }).click();
          await page.getByRole('button', { name: '适合页面', exact: true }).click();
          await selectPreviewObjects(page);
          const styles = await page.locator('.paper,.reading-paper').evaluateAll((nodes) =>
            nodes.map((node) => ({
              className: node.className,
              contain: getComputedStyle(node).contain,
            })),
          );
          expect(styles.length).toBeGreaterThan(0);
          for (const style of styles)
            expect(style.contain).toBe(
              label === 'candidate' ? values['candidate-contain'] : 'none',
            );
          result.styleChecks[label].push({ night, viewName, styles });
          for (const resize of [false, true]) {
            const before = await objectGeometry(page);
            await beginObjectPreview(page, resize);
            const key = `${night ? 'night' : 'day'}-${viewName}-${resize ? 'resize' : 'move'}`;
            const preview = await previewPixels(page),
              geometry = await objectGeometry(page),
              previewRaster = await rasterEvidence(page);
            await finishObjectPreview(page);
            const commitGeometry = await objectGeometry(page),
              committed = await previewPixels(page),
              committedRaster = await rasterEvidence(page);
            expect(commitGeometry).toEqual(geometry);
            for (let i = 0; i < before.length; i++) {
              expect(geometry[i].zIndex).toBe(before[i].zIndex);
              if (!['a', 'c', 'g'].includes(before[i].id)) expect(geometry[i]).toEqual(before[i]);
            }
            for (const [phase, bytes] of [
              ['preview', preview],
              ['committed', committed],
            ]) {
              const id = `${key}-${phase}`,
                name = `${label}-${id}.png`;
              await writeFile(join(destination, name), bytes);
              result.renders[label].push({
                id,
                name,
                sha256: sha(bytes),
                geometry,
                raster: phase === 'preview' ? previewRaster : committedRaster,
                root: await page.locator('.page-editor').first().boundingBox(),
              });
              buffers.set(`${label}-${id}`, bytes);
            }
            result.previewCommit.push({ label, key, ...(await compare(preview, committed)) });
          }
        }
    } finally {
      await app.close();
    }
  }
  for (const a of result.renders.baseline) {
    const b = result.renders.candidate.find((b) => b.id === a.id);
    expect(b.geometry).toEqual(a.geometry);
    expect(b.root).toEqual(a.root);
    expect(b.raster).toEqual(a.raster);
    const check = {
      id: a.id,
      ...(await compare(buffers.get(`baseline-${a.id}`), buffers.get(`candidate-${a.id}`))),
    };
    result.checks.push(check);
  }
  expect(result.errors).toEqual([]);
  result.contentPass = true;
  expect(result.checks.filter((c) => c.different)).toEqual([]);
  result.pass = true;
} catch (e) {
  result.pass = false;
  result.failure = String(e);
  process.exitCode = 1;
} finally {
  await writeFile(join(destination, 'report.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    pass: result.pass,
    checks: result.checks.length,
    previewCommit: result.previewCommit,
    errors: result.errors,
    failure: result.failure,
  }),
);
