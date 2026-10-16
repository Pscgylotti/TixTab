import { test, expect, type Page as BrowserPage } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

async function fixture() {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    page = doc.addPage([400, 300]);
  page.drawRectangle({ x: 20, y: 20, width: 360, height: 260, color: rgb(0.9, 0.95, 1) });
  page.drawText('Title text', { x: 40, y: 240, size: 18, font, color: rgb(0.1, 0.2, 0.6) });
  const png = await doc.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  page.drawImage(png, { x: 40, y: 80, width: 120, height: 90 });
  page.drawText('Body text', { x: 200, y: 120, size: 12, font });
  return Buffer.from(await doc.save());
}
async function open(page: BrowserPage) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'objects.pdf',
      mimeType: 'application/pdf',
      buffer: await fixture(),
    });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'PDF 元素', exact: true }).click();
  await expect(page.locator('.pdf-object-layer')).toHaveAttribute('data-objects', '4');
}
/** Screen point for a PDF point on the 400×300 fixture page. */
async function screen(page: BrowserPage, x: number, y: number) {
  const box = (await page.locator('.pdf-object-layer').boundingBox())!;
  return { x: box.x + (x / 400) * box.width, y: box.y + ((300 - y) / 300) * box.height };
}
/** Centre of the selected outline in page units (origin top-left). */
async function selectedCentre(page: BrowserPage) {
  const points = (await page.locator('.pdf-object-selected').first().getAttribute('points'))!
    .split(' ')
    .map(Number);
  const xs = points.filter((_, i) => i % 2 === 0),
    ys = points.filter((_, i) => i % 2 === 1);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

test('moves a native image with the pen/mouse, keeps others, and undo restores it', async ({
  page,
}) => {
  await open(page);
  const layer = page.locator('.pdf-object-layer');
  const from = await screen(page, 100, 125),
    scale = (await layer.boundingBox())!.width / 400;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 50 * scale, from.y + 20 * scale, { steps: 5 });
  await page.mouse.up();
  await expect(layer).toHaveAttribute('data-selected', '1');
  // Image centre was (100, 175) in page units; it moves by (50, 20).
  await expect.poll(async () => (await selectedCentre(page)).map(Math.round)).toEqual([150, 195]);
  await expect(layer).toHaveAttribute('data-objects', '4');
  await page.screenshot({ path: test.info().outputPath('moved.png') });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(layer).toHaveAttribute('data-selected', '0');
  const again = await screen(page, 100, 125);
  await page.mouse.click(again.x, again.y);
  await expect.poll(async () => (await selectedCentre(page)).map(Math.round)).toEqual([100, 175]);
});

test('rotates, restacks and deletes selected objects through the toolbar and keys', async ({
  page,
}) => {
  await open(page);
  const layer = page.locator('.pdf-object-layer'),
    title = await screen(page, 80, 246);
  await page.mouse.click(title.x, title.y);
  await expect(layer).toHaveAttribute('data-selected', '1');
  await page.getByRole('button', { name: '顺时针旋转 90°', exact: true }).click();
  await expect(layer).not.toHaveClass(/busy/);
  // Rotated text is taller than wide and still one text object.
  await expect
    .poll(async () => {
      const points = (await page.locator('.pdf-object-selected').getAttribute('points'))!
        .split(' ')
        .map(Number);
      const xs = points.filter((_, i) => i % 2 === 0),
        ys = points.filter((_, i) => i % 2 === 1);
      return Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs);
    })
    .toBe(true);
  await page.getByRole('combobox', { name: '对象类型' }).selectOption('text');
  await page.keyboard.press('Control+a');
  await expect(layer).toHaveAttribute('data-selected', '2');
  await page.keyboard.press('Delete');
  await expect(layer).toHaveAttribute('data-objects', '2');
  await page.getByRole('combobox', { name: '对象类型' }).selectOption('all');
  const image = await screen(page, 100, 125);
  await page.mouse.click(image.x, image.y);
  await page.getByRole('button', { name: '置于底层', exact: true }).click();
  await expect(layer).not.toHaveClass(/busy/);
  // The image is now painted first, below the page-sized background rectangle,
  // so a click there selects the rectangle.
  await page.keyboard.press('Escape');
  await page.mouse.click(image.x, image.y);
  await expect.poll(async () => (await selectedCentre(page)).map(Math.round)).toEqual([200, 150]);
});

test('dragging shows the real object pixels moving, then the edited page replaces them', async ({
  page,
}) => {
  await open(page);
  const layer = page.locator('.pdf-object-layer'),
    from = await screen(page, 100, 125),
    scale = (await layer.boundingBox())!.width / 400;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30 * scale, from.y, { steps: 3 });
  // Lifted bitmaps: the page behind the selection and the selection itself.
  await expect(page.locator('.pdf-object-lift')).toHaveCount(2);
  await page.mouse.move(from.x + 60 * scale, from.y + 10 * scale, { steps: 3 });
  const moving = page.locator('.pdf-object-lift').nth(1);
  // The moving bitmap follows the pen by the same page-unit offset (60, 10).
  await expect
    .poll(async () => {
      const m = /matrix\(([^)]*)\)/.exec((await moving.getAttribute('style')) ?? '');
      return m ? m[1].split(',').map((v) => Math.round(Number(v))) : [];
    })
    .toEqual([1, 0, 0, 1, 60, 10]);
  expect(await moving.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(10);
  await page.screenshot({ path: test.info().outputPath('dragging.png') });
  await page.mouse.up();
  await expect.poll(async () => (await selectedCentre(page)).map(Math.round)).toEqual([160, 185]);
  await expect(page.locator('.pdf-object-lift')).toHaveCount(0);
});

test('fill, stroke and line width apply to selected paths as one edit', async ({ page }) => {
  await open(page);
  const layer = page.locator('.pdf-object-layer'),
    background = await screen(page, 300, 60);
  /** Waits for the edited PDF to reload; the inputs then show its values. */
  const reloaded = async (before: string | null) =>
    expect
      .poll(async () => Number(await layer.getAttribute('data-revision')))
      .toBeGreaterThan(Number(before));
  await page.mouse.click(background.x, background.y);
  await expect(page.getByLabel('填充颜色')).toHaveValue('#e6f2ff');
  let before = await layer.getAttribute('data-revision');
  await page.getByLabel('填充颜色').fill('#ff8800');
  await reloaded(before);
  await expect(layer).toHaveAttribute('data-selected', '1');
  await expect(page.getByLabel('填充颜色')).toHaveValue('#ff8800');
  before = await layer.getAttribute('data-revision');
  await page.getByLabel('线宽').fill('4');
  await page.getByLabel('描边颜色').fill('#003366');
  await reloaded(before);
  await expect(page.getByLabel('描边颜色')).toHaveValue('#003366');
  await expect(page.getByLabel('线宽')).toHaveValue('4');
  await expect(layer).toHaveAttribute('data-objects', '4');
});
