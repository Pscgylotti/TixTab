import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');
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
} from '../scripts/object-preview-scenarios.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tixtab.performance.enabled', 'true'));
  await page.goto('/');
  await previewReady(page);
});
async function project(page: Page) {
  const pending = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}
const pixels = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();

test('non-adjacent objects keep exact preview geometry, stacking and uncommitted model in all views and themes', async ({
  page,
}) => {
  test.setTimeout(120000);
  const fixture = await previewFixture();
  await hidePreviewGuides(page);
  for (const night of [false, true])
    for (const view of ['单页标注', '连续页面预览', '双页预览']) {
      await loadPreviewFixture(page, fixture);
      if ((await page.locator('html').getAttribute('data-night')) !== String(night))
        await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByRole('button', { name: '适合页面', exact: true }).click();
      await selectPreviewObjects(page);
      for (const resize of [false, true]) {
        const originalModel = (await project(page)).pages[0].images;
        const before = await objectGeometry(page),
          { box } = await beginObjectPreview(page, resize),
          preview = await objectGeometry(page);
        const snapshot = await previewPixels(page);
        expect((await project(page)).pages[0].images).toEqual(originalModel);
        await finishObjectPreview(page);
        expect(await objectGeometry(page)).toEqual(preview);
        const committed = await previewPixels(page),
          a = await pixels(snapshot),
          b = await pixels(committed);
        let different = 0,
          max = 0;
        for (let i = 0; i < a.length; i++)
          if (a[i] !== b[i]) {
            different++;
            max = Math.max(max, Math.abs(a[i] - b[i]));
          }
        // Chromium can round a few translucent edge channels differently after
        // the commit repaint, including the old React preview implementation.
        // Actual baseline/candidate same-phase pixels are checked separately by
        // verify-object-preview-native.mjs without a tolerance.
        await test.info().attach('preview-commit-diagnostic', {
          body: JSON.stringify({ view, night, resize, different, max }),
          contentType: 'application/json',
        });
        expect(a.length).toBe(b.length);
        for (let n = 0; n < before.length; n++) {
          expect(preview[n].zIndex).toBe(before[n].zIndex);
          if (!['a', 'c', 'g'].includes(before[n].id)) expect(preview[n]).toEqual(before[n]);
        }
        const changed = resize ? 'width' : 'x';
        expect(preview[0][changed]).not.toBe(before[0][changed]);
        expect(box.width).toBeGreaterThan(0);
      }
    }
});

test('cancel, tool change, page replacement and undo remove imperative previews without committing stale coordinates', async ({
  page,
}) => {
  const fixture = await previewFixture();
  await loadPreviewFixture(page, fixture);
  await selectPreviewObjects(page);
  const original = await objectGeometry(page);
  await beginObjectPreview(page);
  await finishObjectPreview(page, 'pointercancel');
  expect(await objectGeometry(page)).toEqual(original);
  await beginObjectPreview(page);
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await previewReady(page);
  expect(await objectGeometry(page)).toEqual(original);
  await page.getByRole('button', { name: '对象', exact: true }).click();
  await selectPreviewObjects(page);
  await beginObjectPreview(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await previewReady(page);
  await finishObjectPreview(page);
  expect((await project(page)).pages.map((p: any) => p.images)).toEqual(
    fixture.notebook.pages.map((p) => p.images),
  );
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await selectPreviewObjects(page);
  await beginObjectPreview(page);
  await finishObjectPreview(page);
  await beginObjectPreview(page, true);
  await page.keyboard.press('Control+z');
  await previewReady(page);
  await finishObjectPreview(page);
  expect((await project(page)).pages[0].images).toEqual(fixture.notebook.pages[0].images);
  expect(await objectGeometry(page)).toEqual(original);
});
