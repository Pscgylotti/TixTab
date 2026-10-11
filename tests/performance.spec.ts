import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, rgb } = createRequire(import.meta.url)('pdf-lib');

test('双页默认翻两页，单页微调保留配对，并正确处理首尾边界', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  for (let i = 0; i < 4; i++)
    await page.getByRole('button', { name: '插入空白页', exact: true }).click();
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  const spread = async (indexes: number[]) => {
    await expect
      .poll(() =>
        page
          .locator('.reading-card')
          .evaluateAll((cards) => cards.map((c) => Number(c.getAttribute('data-page-index')))),
      )
      .toEqual(indexes);
  };
  await spread([0, 1]);
  await expect(page.getByRole('button', { name: '向前移动一页', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await spread([2, 3]);
  await page.getByRole('button', { name: '向前移动一页', exact: true }).click();
  await spread([1, 2]);
  await page.keyboard.press('ArrowRight');
  await spread([3, 4]);
  await page.keyboard.press('Shift+ArrowLeft');
  await spread([2, 3]);
  await page.getByRole('button', { name: '向后移动一页', exact: true }).click();
  await spread([3, 4]);
  await page.getByRole('button', { name: '单页标注', exact: true }).click();
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  await spread([3, 4]);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.keyboard.press('Shift+ArrowRight');
  await spread([4]);
  await expect(page.getByRole('button', { name: '向后移动一页', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await spread([2, 3]);
  await page.keyboard.press('Shift+ArrowLeft');
  await spread([1, 2]);
  await page.keyboard.press('ArrowLeft');
  await spread([0, 1]);
  await page.setViewportSize({ width: 560, height: 1000 });
  for (const button of await page.locator('.page-navigation button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(560);
    expect(box.y + box.height).toBeLessThanOrEqual(1000);
  }
  await page.screenshot({ path: 'test-results/dual-page-navigation.png' });
});

test('1000 页混合尺寸 PDF：视区 DOM 有界、首尾跳转、选文和缩放落点', async ({ page }) => {
  test.setTimeout(120000);
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 1000; i++) {
    const p = pdf.addPage(i % 2 ? [842, 595] : [595, 842]);
    p.drawText(`Document page ${i + 1}`, { x: 50, y: p.getHeight() - 70, size: 24, font });
    p.drawRectangle({ x: 50, y: 100, width: 200, height: 200, color: rgb(0.2, 0.4, 0.7) });
  }
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const started = performance.now();
  await page.locator('input[type=file]').setInputFiles({
    name: '1000-pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const importedMs = Math.round(performance.now() - started);
  await expect(page.locator('.sidebar-heading .count')).toHaveText('1000');
  expect(await page.locator('.page-card').count()).toBeLessThan(12);
  await page.getByRole('button', { name: '连续页面预览', exact: true }).click();
  expect(await page.locator('.reading-card').count()).toBeLessThan(10);
  await page.locator('.page-list').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.getByRole('button', { name: '第 1000 页', exact: true }).click();
  await expect(page.locator('.page-navigation')).toContainText('1000 / 1000');
  await expect(page.locator('.reading-card[data-page-index="999"]')).toBeVisible();
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.reading-card[data-page-index="999"] .textLayer')).toContainText(
    'Document page 1000',
  );
  const last = page.locator('.reading-card[data-page-index="999"]');
  const before = await last.locator('.textLayer span').first().boundingBox();
  // Full-page fit now keeps the entire page visible. Enlarge first so both axes
  // have scroll room; otherwise centering at the edge legitimately clamps pan.
  await page.locator('.reading-view').evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new WheelEvent('wheel', {
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        deltaY: -180,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(() =>
      page.locator('.reading-view').evaluate((el) => el.scrollWidth > el.clientWidth + 50),
    )
    .toBe(true);
  await page.locator('.reading-view').evaluate((el) => {
    el.scrollLeft = 0;
    el.scrollTop = (el.querySelector<HTMLElement>('[data-page-index="999"]')?.offsetTop || 0) - 200;
  });
  const text = await last.locator('.textLayer span').first().boundingBox();
  await page.locator('.reading-view').evaluate(
    (el, p) =>
      el.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: p!.x + 10,
          clientY: p!.y + 10,
          deltaY: -40,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    text,
  );
  await expect(last).toBeVisible();
  const after = await last.locator('.textLayer span').first().boundingBox();
  expect(Math.abs(after!.x + 10 * Math.exp(0.32) - (text!.x + 10))).toBeLessThan(3);
  expect(Math.abs(after!.y + 10 * Math.exp(0.32) - (text!.y + 10))).toBeLessThan(3);
  expect(await page.locator('.reading-card').count()).toBeLessThan(10);
  expect(await page.locator('.page-card').count()).toBeLessThan(12);
  await page.locator('.page-list').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await expect(page.locator('.reading-card[data-page-index="0"]')).toBeVisible();
  await expect(page.locator('.reading-card[data-page-index="0"] .textLayer')).toContainText(
    'Document page 1',
  );
  await page.screenshot({ path: 'test-results/long-document-virtualized.png' });
  console.log(
    JSON.stringify({
      pages: 1000,
      importMs: importedMs,
      mountedReadingPages: await page.locator('.reading-card').count(),
      mountedThumbnails: await page.locator('.page-card').count(),
      page1000TextTop: before?.y,
    }),
  );
});

test('虚拟缩略图长按跨视区排序，源卡片卸载后仍能松手提交和撤销', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const notebook = {
    version: 1,
    name: '排序样本',
    source: null,
    pages: Array.from({ length: 100 }, (_, i) => ({
      id: `page-${i}`,
      sourceIndex: null,
      width: 595,
      height: 842,
      strokes: [],
      images: [],
      paper: 'plain',
    })),
  };
  await page.locator('input[type=file]').setInputFiles({
    name: 'sort.surfacetab',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(notebook)),
  });
  await expect(page.locator('.sidebar-heading .count')).toHaveText('100');
  const first = (await page.getByRole('button', { name: '第 1 页', exact: true }).boundingBox())!,
    bounds = (await page.locator('.page-list').boundingBox())!;
  await page.mouse.move(first.x + 50, first.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(first.x + 50, bounds.y + bounds.height - 3, { steps: 10 });
  await expect(page.getByRole('button', { name: '第 1 页', exact: true })).toHaveCount(0, {
    timeout: 6000,
  });
  await expect
    .poll(() => page.locator('.page-list').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(600);
  const target = Number(await page.locator('.drop-target').getAttribute('data-page-index'));
  expect(target).toBeGreaterThan(4);
  await page.mouse.up();
  const inspect = () =>
    page.evaluate(async () => {
      const { loadWorkspaceDocument, listWorkspace } = await import(
        '/src/workspaceStore.ts' as string
      );
      const { documents } = await listWorkspace();
      return (await loadWorkspaceDocument(
        documents.find((d: { name: string }) => d.name === '排序样本').id,
        false,
      ))!.notebook.pages.map((p: { id: string }) => p.id);
    });
  await expect.poll(async () => (await inspect()).indexOf('page-0')).toBeGreaterThan(4);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await inspect())[0]).toBe('page-0');
});
