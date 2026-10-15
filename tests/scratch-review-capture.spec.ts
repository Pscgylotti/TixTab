import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, rgb } = createRequire(import.meta.url)('pdf-lib');

async function setup(page: Page, mode = '单页标注', hide = false) {
  await page.addInitScript(() => localStorage.setItem('surfacetab.inkColor', '#ff0000'));
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 2; i++)
    pdf
      .addPage([400, 600])
      .drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0, 0, 1) });
  await page.locator('input[type=file]').setInputFiles({
    name: 'scratch-review.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('button', { name: '草稿', exact: true }).click();
  await page.getByRole('button', { name: '进入草稿模式', exact: true }).click();
  if (hide) await page.getByRole('button', { name: '隐藏原 PDF', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.scratch-paper')).toBeVisible();
}
async function drag(page: Page, x: number, y: number, endX: number, endY: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
}
async function pixels(image: ReturnType<Page['locator']>) {
  return image.evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0,
      blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 160 && data[i + 1] < 100 && data[i + 2] < 100) red++;
      if (data[i + 2] > 160 && data[i] < 100 && data[i + 1] < 100) blue++;
    }
    return { red, blue, width: canvas.width, height: canvas.height };
  });
}

test('scratch review cards stay near anchors; one-shot creation selects hand editing and X closes just that card', async ({
  page,
}) => {
  await setup(page, '双页预览', true);
  const area = (await page.locator('.canvas-container').boundingBox())!;
  await page.getByRole('button', { name: '便签', exact: true }).click();
  await drag(page, area.x + 60, area.y + 180, area.x + 160, area.y + 240);
  await expect(page.getByRole('button', { name: '移动', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const anchor = page.locator('.scratch-viewport .review-anchor');
  const card = page.locator('.scratch-viewport .review-card');
  await expect(card).toBeVisible();
  const a = (await anchor.boundingBox())!,
    c = (await card.boundingBox())!;
  expect(c.x).toBeCloseTo(a.x + a.width + 14, 0);
  expect(c.width).toBeCloseTo(240, 0);
  await page.getByLabel('便签内容', { exact: true }).fill('Scratch note');
  await expect(page.locator('.scratch-viewport .review-resize-handle')).toHaveCount(4);
  await drag(page, a.x + 15, a.y + a.height / 2, a.x + 45, a.y + a.height / 2 + 20);
  expect((await anchor.boundingBox())!.x).toBeCloseTo(a.x + 30, 0);
  await page.getByRole('button', { name: '关闭便签', exact: true }).click();
  await expect(card).toHaveCount(0);
  await anchor.hover();
  await expect(card).toHaveCount(0);
  await anchor.click();
  await expect(page.getByLabel('便签内容', { exact: true })).toHaveValue('Scratch note');
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await expect(card.locator('textarea')).toHaveCount(0);
  await expect(page.locator('.review-resize-handle')).toHaveCount(0);
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await anchor.click();
  await expect(card.locator('textarea')).toBeVisible();
  // A second note has its own close state, even while a different note is selected.
  await page.getByRole('button', { name: '便签', exact: true }).click();
  await drag(page, area.x + 60, area.y + 360, area.x + 150, area.y + 410);
  await expect(page.locator('.scratch-viewport .review-anchor')).toHaveCount(2);
  await expect(card).toHaveCount(2);
  await card.first().getByRole('button', { name: '关闭便签', exact: true }).click();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('便签 2');
});

for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
  test(`${mode}: OCR captures scratch ink and overlapping PDF pixels from the correct sheet`, async ({
    page,
  }) => {
    await setup(page, mode);
    const area = (await page.locator('.canvas-container').boundingBox())!;
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    await drag(page, area.x + 45, area.y + 180, area.x + 130, area.y + 205);
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    await drag(page, area.x + 20, area.y + 155, area.x + 150, area.y + 230);
    const preview = page.getByRole('dialog', { name: '截图预览', exact: true });
    await expect(preview).toBeVisible();
    const image = preview.locator('img');
    const source = await image.getAttribute('src');
    const background = await pixels(image);
    expect(background.red).toBeGreaterThan(50);
    expect(background.blue).toBe(0);
    expect(background.width * background.height).toBeLessThanOrEqual(4_000_000);
    await preview.getByRole('button', { name: '识别文字（OCR）', exact: true }).click();
    const ocr = page.getByRole('dialog', { name: '区域识别', exact: true });
    await expect(ocr).toBeVisible();
    await expect(ocr.locator('img')).toHaveAttribute('src', source!);
    await ocr.getByRole('button', { name: '关闭', exact: true }).click();
    const front = (await page
      .locator('.paper:not(.scratch-paper),.reading-paper')
      .first()
      .boundingBox())!;
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    await drag(
      page,
      front.x + front.width * 0.3,
      front.y + front.height * 0.3,
      front.x + front.width * 0.6,
      front.y + front.height * 0.5,
    );
    await expect(preview).toBeVisible();
    const foreground = await pixels(preview.locator('img'));
    expect(foreground.blue).toBeGreaterThan(100);
    expect(foreground.red).toBe(0);
  });
}

test('scratch region capture never decodes offscreen image payloads', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { capturePage } = await import('/src/capturePage.ts' as string);
    const { blankPage } = await import('/src/model.ts' as string);
    return capturePage(
      {
        ...blankPage(20000, 20000),
        images: [
          {
            id: 'offscreen',
            kind: 'image',
            data: 'not-an-image',
            x: 18000,
            y: 18000,
            width: 100,
            height: 100,
          },
        ],
      },
      null,
      { x: 9990, y: 9990, width: 40, height: 30 },
    );
  });
  expect(result).toMatch(/^data:image\/png;base64,/);
});
