// Production renderer, isolated profile, synthetic pen events; no model loading
// or external URL requests. Pass a packaged TixTab.exe to verify the release too.
import { _electron as electron, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const cache = join(root, '.cache');
const profile = await mkdtemp(join(cache, 'pen-native-'));
const packaged = process.argv[2];
const app = await electron.launch({
  executablePath: resolve(packaged || 'node_modules/electron/dist/electron.exe'),
  args: packaged ? [] : [root],
  env: { ...process.env, SURFACETAB_PROFILE: profile, SURFACETAB_DEV: '0' },
  timeout: 60000,
});
const result = { productionRenderer: true, realPenHardwareTested: false, views: [], errors: [] };
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => result.errors.push(error.message));
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 768;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e64a35';
    ctx.fillRect(0, 0, c.width, c.height);
    return c.toDataURL();
  });
  const doc = await PDFDocument.create();
  const a = doc.addPage([600, 800]),
    b = doc.addPage([600, 800]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(png);
  a.drawImage(image, { x: 200, y: 400, width: 180, height: 135 });
  a.drawText('Reference', { x: 60, y: 700, size: 16, font });
  a.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [60, 695, 140, 720],
          Dest: [b.ref, PDFName.of('Fit')],
        }),
      ),
    ]),
  );
  const buffer = Buffer.from(await doc.save());
  const position = async (x, y) => {
    const box = await page.locator('.paper,.reading-paper').first().boundingBox();
    return { x: box.x + (box.width * x) / 600, y: box.y + (box.height * y) / 800 };
  };
  const pen = async (at, events) =>
    page.evaluate(
      ({ at, events }) => {
        for (const [type, button, buttons, pressure] of events) {
          const target = document.elementFromPoint(at.x, at.y);
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType: 'pen',
              pointerId: 71,
              clientX: at.x,
              clientY: at.y,
              button,
              buttons,
              pressure,
            }),
          );
        }
      },
      { at, events },
    );
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.locator('input[type=file]').setInputFiles({
      name: `pen-${result.views.length}.pdf`,
      mimeType: 'application/pdf',
      buffer,
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    const at = await position(290, 330);
    await pen(at, [['pointermove', -1, 2, 0]]);
    await expect(page.locator('[data-pen-interactive=image]')).toHaveCount(1);
    await expect(page.locator('.pen-interaction-active [data-pen-interactive=link]')).toHaveCount(
      1,
    );
    await pen(at, [
      ['pointermove', 0, 3, 0.6],
      ['pointermove', -1, 3, 0.6],
      ['pointerup', 0, 0, 0],
    ]);
    const modal = page.getByRole('dialog', { name: '原图', exact: true });
    await expect(modal).toBeVisible();
    await expect
      .poll(() => modal.locator('canvas').evaluate((c) => [c.width, c.height]))
      .toEqual([1024, 768]);
    const pixel = await modal
      .locator('canvas')
      .evaluate((c) => [...c.getContext('2d').getImageData(0, 0, 1, 1).data]);
    assert.deepEqual(pixel, [230, 74, 53, 255]);
    await pen(at, [['pointerup', 2, 0, 0]]);
    await page.getByRole('button', { name: '关闭原图' }).click();
    const reference = await position(90, 92);
    await pen(reference, [['pointerdown', 2, 2, 0.6]]);
    await pen(reference, [['pointerup', 2, 0, 0]]);
    await expect(page.locator('.page-card.selected')).toContainText('02');
    await expect(page.getByRole('menu', { name: '笔侧键工具环' })).toHaveCount(0);
    await pen(reference, [['pointerup', 2, 0, 0]]);
    result.views.push({ view, highlights: true, image: [1024, 768], pixel, reference: true });
  }
  assert.deepEqual(result.errors, []);
  await writeFile(join(cache, 'pen-interaction-native.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: join(cache, 'pen-interaction-native-failure.png') });
  console.error(
    JSON.stringify({
      ...result,
      failure: String(error),
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    }),
  );
  throw error;
} finally {
  await app.close();
  // Only this invocation's mkdtemp profile, never the user's workspace/profile.
  if (dirname(profile) === cache && profile.startsWith(join(cache, 'pen-native-')))
    await rm(profile, { recursive: true, force: true });
}
