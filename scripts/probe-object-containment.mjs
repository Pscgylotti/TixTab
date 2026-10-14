import { _electron as electron, expect } from '@playwright/test';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import {
  previewFixture,
  loadPreviewFixture,
  selectPreviewObjects,
  beginObjectPreview,
  finishObjectPreview,
  previewPixels,
  previewReady,
} from './object-preview-scenarios.mjs';
const sharp = createRequire(import.meta.url)('sharp');
const { values } = parseArgs({
  options: { 'app-dir': { type: 'string' }, output: { type: 'string' } },
});
if (!values['app-dir'] || !values.output) throw Error('Supply frozen app and fresh directory');
const out = resolve(values.output),
  sha = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(out);
const fixture = await previewFixture();
await writeFile(join(out, 'fixture.tixtab'), fixture.bytes);
const report = {
  harnessSha256: sha(await readFile(new URL(import.meta.url))),
  scenariosSha256: sha(await readFile(new URL('./object-preview-scenarios.mjs', import.meta.url))),
  sourceManifestSha256: sha(await readFile(join(values['app-dir'], 'SOURCE-MANIFEST.json'))),
  fixtureSha256: sha(fixture.bytes),
  errors: [],
  checks: [],
};
const app = await electron.launch({
  args: [resolve(values['app-dir'])],
  env: {
    ...process.env,
    SURFACETAB_DEV: '0',
    SURFACETAB_PROFILE: await mkdtemp(join(tmpdir(), 'tixtab-containment-probe-')),
  },
  timeout: 60000,
});
const variations = [
  ['none', 'none', 0],
  ['style', 'style', 0],
  ['layout', 'layout style', 0],
  ['paint', 'paint', 2],
  ['content', 'layout paint style', 2],
  ['wide-clip', 'layout paint style', 64],
  ['restore', 'none', 0],
];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => report.errors.push(String(e)));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  );
  await page.addInitScript(() => localStorage.setItem('tixtab.performance.enabled', 'true'));
  await page.reload();
  await previewReady(page);
  for (const night of [false, true]) {
    await loadPreviewFixture(page, fixture, join(out, 'fixture.tixtab'));
    if ((await page.locator('html').getAttribute('data-night')) !== String(night))
      await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
    await selectPreviewObjects(page);
    for (const resize of [false, true]) {
      await beginObjectPreview(page, resize);
      await finishObjectPreview(page);
      let reference;
      for (const [label, contain, margin] of variations) {
        const computed = await page.locator('.page-editor .placed-object').evaluateAll(
          (nodes, { contain, margin }) =>
            nodes.map((n) => {
              n.style.contain = contain;
              n.style.overflowClipMargin = margin + 'px';
              const s = getComputedStyle(n),
                r = n.getBoundingClientRect();
              return {
                id: n.dataset.objectId,
                contain: s.contain,
                overflowClipMargin: s.overflowClipMargin,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                zIndex: s.zIndex,
              };
            }),
          { contain, margin },
        );
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const bytes = await previewPixels(page),
          pixels = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (!reference) reference = pixels;
        expect(pixels.info).toEqual(reference.info);
        let different = 0,
          max = 0;
        for (let i = 0; i < pixels.data.length; i++) {
          const d = Math.abs(pixels.data[i] - reference.data[i]);
          if (d) {
            different++;
            max = Math.max(max, d);
          }
        }
        const name = `${night ? 'night' : 'day'}-${resize ? 'resize' : 'move'}-${label}.png`;
        await writeFile(join(out, name), bytes);
        report.checks.push({
          night,
          resize,
          label,
          computed,
          name,
          sha256: sha(bytes),
          different,
          max,
          width: pixels.info.width,
          height: pixels.info.height,
        });
      }
      await page.locator('.page-editor .placed-object').evaluateAll((nodes) =>
        nodes.forEach((n) => {
          n.style.removeProperty('contain');
          n.style.removeProperty('overflow-clip-margin');
        }),
      );
    }
  }
  expect(report.errors).toEqual([]);
} catch (e) {
  report.failure = String(e);
  process.exitCode = 1;
} finally {
  await app.close();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    checks: report.checks.map(({ night, resize, label, different, max }) => ({
      night,
      resize,
      label,
      different,
      max,
    })),
    errors: report.errors,
    failure: report.failure,
  }),
);
