import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
test('stopping retains completed pictures, retry indexes grouped pictures; English night portrait fits', async ({
  page,
}) => {
  let calls = 0,
    blocking = true,
    release: () => void = () => {};
  await page.route('http://127.0.0.1:8766/health', (r) =>
    r.fulfill({
      json: {
        ok: true,
        engine: 'Texo OpenVINO',
        devices: [{ id: 'CPU', name: 'CPU' }],
        capabilities: ['ocr-experimental'],
      },
    }),
  );
  await page.route('http://127.0.0.1:8766/ocr', async (r) => {
    calls++;
    if (calls === 2 && blocking) await new Promise<void>((resolve) => (release = resolve));
    await r
      .fulfill({
        json: {
          text: 'picture word',
          lines: [],
          confidence: 98,
          devices: { det: ['CPU'], rec: ['CPU'] },
          projectionDevice: 'CPU',
          timing: { totalMs: 10 },
        },
      })
      .catch(() => {});
  });
  await page.goto('/');
  const text = await page.evaluate(async () => {
    const { newNotebook } = await import('/src/model.ts' as string);
    const n = newNotebook();
    n.name = 'Grouped pictures';
    const c = document.createElement('canvas');
    c.width = c.height = 100;
    c.getContext('2d')!.fillRect(0, 0, 100, 100);
    const image = (id: string) => ({
      id,
      kind: 'image',
      data: c.toDataURL(),
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    });
    n.pages[0].images = [
      image('a'),
      { ...image('g'), group: { width: 300, height: 100, objects: [image('b'), image('c')] } },
    ];
    return JSON.stringify(n);
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'grouped.tixtab',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  await page.getByRole('button', { name: '解析位图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '解析位图' });
  await dialog.getByRole('button', { name: '开始解析', exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await dialog.getByRole('button', { name: '停止', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已停止');
  blocking = false;
  release();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const first = await saved(page);
  expect(first.pages[0].images[0].ocr.text).toBe('picture word');
  expect(first.pages[0].images[1].group.objects[0].ocr).toBeUndefined();
  await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
  await page.getByRole('button', { name: '解析位图', exact: true }).click();
  await dialog.getByRole('button', { name: '开始解析', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('解析完成：2 张位图');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const retry = await saved(page);
  expect(retry.pages[0].images[1].group.objects.every((i: { ocr?: unknown }) => i.ocr)).toBe(true);
  expect(calls).toBe(4);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('界面语言 / Interface language').selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Experimental night mode', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 900 });
  await page.getByRole('button', { name: 'Region OCR', exact: true }).click();
  await page.getByRole('button', { name: 'Analyze bitmaps', exact: true }).click();
  const english = page.getByRole('dialog', { name: 'Analyze bitmaps' });
  await expect(english).toBeInViewport();
  expect(await english.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(english).toHaveCount(0);
});
async function fixture(page: Page) {
  await page.goto('/');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 200, 100);
    ctx.fillStyle = 'black';
    ctx.font = '20px Arial';
    ctx.fillText('Bitmap alpha', 10, 30);
    return c.toDataURL();
  });
  const doc = await PDFDocument.create(),
    image = await doc.embedPng(png);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([600, 800]);
    p.drawImage(image, { x: 100, y: 450, width: 300, height: 150 });
  }
  await page.locator('input[type=file]').setInputFiles({
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function saved(page: Page) {
  const wait = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  return JSON.parse(await fs.readFile((await (await wait).path())!, 'utf8'));
}
test('bitmap OCR ranges, persistence, skipping, search line highlights and undo', async ({
  page,
}) => {
  let calls = 0;
  await page.route('http://127.0.0.1:8766/health', (r) =>
    r.fulfill({
      json: {
        ok: true,
        engine: 'Texo OpenVINO',
        devices: [{ id: 'CPU', name: 'CPU' }],
        capabilities: ['ocr-experimental'],
      },
    }),
  );
  await page.route('http://127.0.0.1:8766/ocr', async (r) => {
    calls++;
    await r.fulfill({
      json: {
        text: 'Bitmap alpha',
        lines: [
          { text: 'Bitmap alpha', polygon: [10, 10, 190, 10, 190, 40, 10, 40], confidence: 98 },
        ],
        confidence: 98,
        devices: { det: ['CPU'], rec: ['CPU'] },
        projectionDevice: 'CPU',
        timing: { totalMs: 10 },
      },
    });
  });
  await fixture(page);
  const open = async () => {
    await page.getByRole('button', { name: '框选 OCR', exact: true }).click();
    await page.getByRole('button', { name: '解析位图', exact: true }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: '解析位图' });
  await expect(dialog.getByRole('checkbox', { name: '全文', exact: true })).toBeChecked();
  await dialog.getByRole('checkbox', { name: '全文', exact: true }).uncheck();
  await dialog.getByRole('textbox', { name: '页码范围', exact: true }).fill('2-4');
  await expect(dialog.getByRole('button', { name: '开始解析' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: '页码范围', exact: true }).fill('2');
  await dialog.getByRole('button', { name: '开始解析' }).click();
  await expect(dialog.getByRole('status')).toContainText('解析完成：1 张位图');
  expect(calls).toBe(1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const n = await saved(page);
  expect(n.pages[0].bitmapOcr).toBeUndefined();
  expect(n.pages[1].bitmapOcr[0].result.lines[0].polygon).toEqual([
    0.05, 0.1, 0.95, 0.1, 0.95, 0.4, 0.05, 0.4,
  ]);
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: '搜索文档文字' }).fill('alpha');
  await expect(page.locator('.document-search-results button')).toHaveCount(1);
  await page.locator('.document-search-results button').click();
  const mark = page.locator('.pdf-search-mark');
  await expect(mark).toHaveCount(1);
  expect(
    await mark.evaluate((el) => ({
      x: parseFloat((el as HTMLElement).style.left),
      y: parseFloat((el as HTMLElement).style.top),
      width: parseFloat((el as HTMLElement).style.width),
      height: parseFloat((el as HTMLElement).style.height),
    })),
  ).toEqual({ x: 115, y: 215, width: 270, height: 45 });
  await open();
  await dialog.getByRole('button', { name: '开始解析' }).click();
  await expect(dialog.getByRole('status')).toContainText('解析完成：2 张位图');
  expect(calls).toBe(3);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.document-search-results button')).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.document-search-results button')).toHaveCount(1);
  await page.keyboard.press('Control+y');
  await expect(page.locator('.document-search-results button')).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = await import('/src/workspaceStore.ts' as string);
        const { documents } = await s.listWorkspace();
        const { notebook } = await s.loadWorkspaceDocument(
          documents.find((d: { name: string }) => d.name === 'scan').id,
          false,
        );
        return notebook.pages.filter((p: { bitmapOcr?: unknown[] }) => p.bitmapOcr?.length).length;
      }),
    )
    .toBe(3);
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: '搜索文档文字' }).fill('alpha');
  await expect(page.locator('.document-search-results button')).toHaveCount(3);
});
