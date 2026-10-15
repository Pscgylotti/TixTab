import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function idle(page: Page) {
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function notebook(page: Page) {
  return page.evaluate(async () => {
    const s = await import('/src/workspaceStore.ts' as string);
    return (await s.bootstrapWorkspace()).notebook;
  });
}
async function panel(page: Page) {
  await page.getByRole('button', { name: '草稿', exact: true }).click();
  return page.getByRole('dialog', { name: '草稿纸', exact: true });
}
async function enter(page: Page) {
  const p = await panel(page);
  if (await p.getByRole('button', { name: '进入草稿模式', exact: true }).count())
    await p.getByRole('button', { name: '进入草稿模式', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.scratch-paper')).toBeVisible();
}
async function draw(page: Page, points: { x: number; y: number }[]) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await idle(page);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++)
    pdf.addPage([360, 480]).drawText(`Page ${i + 1}`, { x: 40, y: 400, size: 20, font });
  await page.locator('input[type=file]').setInputFiles({
    name: 'Scratch fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await idle(page);
});
test('scratch management persists only project data, ten sheets, color, clear/undo and PDF export excludes scratch', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: '加页', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '插入空白页', exact: true })).toBeVisible();
  await enter(page);
  const r = (await page.locator('.canvas-container').boundingBox())!;
  await draw(page, [
    { x: r.x + 40, y: r.y + 100 },
    { x: r.x + 120, y: r.y + 120 },
  ]);
  await expect
    .poll(async () => (await notebook(page)).scratchPapers?.[0].page.strokes.length)
    .toBe(1);
  let p = await panel(page);
  await p.getByLabel('重命名草稿纸1').fill('计算');
  await p.getByLabel('草稿背景颜色').fill('#f7ead2');
  await expect
    .poll(async () => (await notebook(page)).scratchPapers?.[0].page.paperColor)
    .toBe('#f7ead2');
  await p.getByRole('button', { name: '清空当前草稿纸', exact: true }).click();
  await p.getByRole('button', { name: '确认清空', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await notebook(page)).scratchPapers?.[0].page.strokes.length)
    .toBe(1);
  p = await panel(page);
  for (let i = 1; i < 10; i++) await p.getByRole('button', { name: /新建/ }).click();
  await expect(p.getByRole('button', { name: /新建/ })).toBeDisabled();
  await expect.poll(async () => (await notebook(page)).scratchPapers?.length).toBe(10);
  await page.keyboard.press('Escape');
  const check = await page.evaluate(async () => {
    const s = await import('/src/storage.ts' as string),
      w = await import('/src/workspaceStore.ts' as string);
    const n = (await w.bootstrapWorkspace()).notebook;
    return s.decodeProject(s.encodeProject(n));
  });
  expect(check.scratchPapers).toHaveLength(10);
  expect(check.pages).toHaveLength(3);
  const bytes = await page.evaluate(async () => {
    const w = await import('/src/workspaceStore.ts' as string),
      m = await import('/src/pdf.ts' as string);
    return [...(await m.exportPdf((await w.bootstrapWorkspace()).notebook))];
  });
  expect((await PDFDocument.load(new Uint8Array(bytes))).getPageCount()).toBe(3);
  await page.reload();
  await idle(page);
  await enter(page);
  p = await panel(page);
  await expect(p.getByLabel('重命名计算')).toHaveValue('计算');
  await p.getByRole('button', { name: '选择计算', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.scratch-paper')).toHaveCSS('background-color', 'rgb(247, 234, 210)');
});
for (const [label, mode] of [
  ['单页标注', 'single'],
  ['连续页面预览', 'continuous'],
  ['双页预览', 'dual'],
] as const) {
  test(`${mode}: independent PDF/background pan/zoom, fit, crossing ink and exit restores view`, async ({
    page,
  }) => {
    if (mode !== 'single') await page.getByRole('button', { name: label, exact: true }).click();
    const pdfPaper = page.locator(mode === 'single' ? '.surface .paper' : '.reading-paper').first();
    const before = (await pdfPaper.boundingBox())!;
    await enter(page);
    await page.getByRole('button', { name: '移动', exact: true }).click();
    const view = (await page.locator('.canvas-container').boundingBox())!;
    const scratchBefore = (await page.locator('.scratch-paper').boundingBox())!;
    await draw(page, [
      { x: view.x + 35, y: view.y + 100 },
      { x: view.x + 115, y: view.y + 130 },
    ]);
    const scratchAfter = (await page.locator('.scratch-paper').boundingBox())!;
    expect(scratchAfter.x - scratchBefore.x).toBeCloseTo(80, 0);
    const unchanged = (await pdfPaper.boundingBox())!;
    expect(unchanged.x).toBeCloseTo(before.x, 0);
    const p = (await pdfPaper.boundingBox())!;
    await draw(page, [
      { x: p.x + 80, y: p.y + 80 },
      { x: p.x + 170, y: p.y + 120 },
    ]);
    const moved = (await pdfPaper.boundingBox())!;
    expect(moved.x - p.x).toBeCloseTo(90, 0);
    expect((await page.locator('.scratch-paper').boundingBox())!.x).toBeCloseTo(scratchAfter.x, 0);
    await page.mouse.move(view.x + 35, view.y + 100);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -35);
    await page.keyboard.up('Control');
    await expect
      .poll(async () =>
        Number(await page.locator('.scratch-viewport').getAttribute('data-scratch-zoom')),
      )
      .toBeGreaterThan(1);
    expect((await pdfPaper.boundingBox())!.width).toBeCloseTo(moved.width, 0);
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    const actual = (await pdfPaper.boundingBox())!;
    await draw(page, [
      { x: actual.x + actual.width - 30, y: actual.y + 100 },
      { x: actual.x + actual.width + 50, y: actual.y + 100 },
    ]);
    await expect
      .poll(async () => {
        const n = await notebook(page);
        return n.pages[0].strokes.length > 0 && n.scratchPapers?.[0].page.strokes.length > 0;
      })
      .toBe(true);
    await page.getByRole('button', { name: '适合页面', exact: true }).click();
    const fit = (await pdfPaper.boundingBox())!;
    expect(fit.x).toBeGreaterThanOrEqual(view.x - 1);
    expect(fit.x + fit.width).toBeLessThanOrEqual(view.x + view.width + 1);
    const pop = await panel(page);
    await pop.getByRole('button', { name: '退出草稿模式', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.scratch-viewport')).toHaveCount(0);
    await expect
      .poll(async () => (await pdfPaper.boundingBox())!.width)
      .toBeCloseTo(before.width, 0);
  });
}
test('page long drag makes an independent ordered object with disabled copy; hidden PDF routes centered text and clipboard to scratch', async ({
  page,
}) => {
  await enter(page);
  const card = (await page.locator('.page-card').first().boundingBox())!;
  const view = (await page.locator('.canvas-container').boundingBox())!;
  await page.mouse.move(card.x + 40, card.y + 40);
  await page.mouse.down();
  await expect(page.locator('.page-actions-menu')).toBeVisible();
  await page.mouse.move(view.x + 150, view.y + 150, { steps: 6 });
  await expect(page.locator('.scratch-page-drag-preview')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.scratch-page-drag-preview')).toHaveCount(0);
  await idle(page);
  await expect
    .poll(async () => (await notebook(page)).scratchPapers?.[0].page.images.length)
    .toBe(1);
  let n = await notebook(page);
  expect(n.scratchPapers![0].page.images[0].scratchPage).toBe(true);
  expect(n.pages).toHaveLength(3);
  await expect(page.getByRole('button', { name: '复制选中对象', exact: true })).toBeDisabled();
  const pop = await panel(page);
  await pop.getByRole('button', { name: '隐藏原 PDF', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.surface')).toHaveCount(0);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'Scratch note');
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
  });
  await idle(page);
  await expect
    .poll(async () => (await notebook(page)).scratchPapers?.[0].page.images.length)
    .toBe(2);
  n = await notebook(page);
  const object = n.scratchPapers![0].page.images[1];
  expect(object.textBox?.content).toBe('Scratch note');
  const center = await page.evaluate(async () => {
    const w = await import('/src/workspaceStore.ts' as string),
      s = await import('/src/scratchPaper.ts' as string);
    return s.scratchInsertionAnchor((await w.bootstrapWorkspace()).notebook);
  });
  expect(object.x + object.width / 2).toBeCloseTo(center.x, 0);
  expect(object.y + object.height / 2).toBeCloseTo(center.y, 0);
  // Bounded raster allocation even though the square sheet is 20,000 units wide.
  const canvases = await page
    .locator('.scratch-viewport canvas')
    .evaluateAll((cs) =>
      cs.map((c) => (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height),
    );
  expect(Math.max(...canvases, 0)).toBeLessThanOrEqual(16_000_000);
  await page.screenshot({ path: 'test-results/scratch-paper.png' });
});
test('cross-sheet ink previews both sides before release; night colors and seamless page tracking survive tab/restart', async ({
  page,
}) => {
  await enter(page);
  const pdf = page.locator('.surface .paper'),
    r = (await pdf.boundingBox())!;
  await page.mouse.move(r.x + r.width - 30, r.y + 100);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width + 65, r.y + 100, { steps: 12 });
  const preview = page.locator('.scratch-cross-ink');
  await expect.poll(() => preview.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(1);
  const alpha = await preview.evaluate(
    (c: HTMLCanvasElement, point) => {
      const b = c.getBoundingClientRect(),
        x = Math.floor(((point.x - b.x) * c.width) / b.width),
        y = Math.floor(((point.y - b.y) * c.height) / b.height);
      const pixels = c
        .getContext('2d')!
        .getImageData(Math.max(0, x - 3), Math.max(0, y - 3), 6, 6).data;
      return [...pixels].some((v, i) => i % 4 === 3 && v > 0);
    },
    { x: r.x + r.width + 40, y: r.y + 100 },
  );
  expect(alpha).toBe(true);
  await page.screenshot({ path: 'test-results/scratch-crossing-live.png' });
  await page.mouse.up();
  await expect.poll(() => preview.evaluate((c: HTMLCanvasElement) => c.width)).toBe(1);
  await page.getByRole('button', { name: '实验性夜间模式', exact: true }).click();
  await expect(page.locator('.scratch-paper')).not.toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  const sheets = page.locator('.reading-paper');
  await expect(sheets).toHaveCount(3);
  await expect.poll(async () => (await sheets.first().boundingBox())!.height).toBeGreaterThan(500);
  const a = (await sheets.nth(0).boundingBox())!,
    b = (await sheets.nth(1).boundingBox())!;
  expect(b.y - a.y - a.height).toBeCloseTo(0, 0);
  await expect(sheets.first()).not.toHaveCSS('box-shadow', 'none');
  await page.mouse.move(a.x + a.width / 2, a.y + 100);
  await page.mouse.wheel(0, a.height + 60);
  await expect(page.locator('.page-navigation')).toContainText('2 / 3');
  const paperX = await page.locator('.scratch-viewport').getAttribute('data-scratch-x');
  await page.getByRole('button', { name: '新建文档标签', exact: true }).click();
  await idle(page);
  await expect(page.locator('.scratch-viewport')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Scratch fixture', exact: true }).click();
  await idle(page);
  await expect(page.locator('.scratch-viewport')).toBeVisible();
  await expect(page.locator('.reading-continuous')).toBeVisible();
  await expect(page.locator('.scratch-viewport')).toHaveAttribute('data-scratch-x', paperX!);
  await expect(page.locator('.page-navigation')).toContainText('2 / 3');
  await page.reload();
  await idle(page);
  await expect(page.locator('.scratch-viewport')).toBeVisible();
  await expect(page.locator('.reading-continuous')).toBeVisible();
  const pop = await panel(page);
  await expect(pop).not.toContainText('草稿仅保存到工程');
  await page.screenshot({ path: 'test-results/scratch-panel-night.png' });
  await pop.getByRole('button', { name: '退出草稿模式', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.reading-continuous')).toBeVisible();
});
