import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, PDFName, PDFString } = createRequire(import.meta.url)(
  'pdf-lib',
);
async function fixture() {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    a = doc.addPage([595, 842]),
    b = doc.addPage([595, 842]);
  a.drawText('First page alpha', { x: 50, y: 750, size: 18, font });
  a.drawText('https://example.org/plain', { x: 50, y: 700, size: 14, font });
  a.drawText('See reference', { x: 50, y: 650, size: 14, font });
  a.drawText('https://example.org/', { x: 50, y: 600, size: 14, font });
  a.drawText('wrapped', { x: 50, y: 580, size: 14, font });
  b.drawText('Second page beta target', { x: 50, y: 700, size: 18, font });
  a.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [50, 645, 160, 670],
          Dest: [b.ref, PDFName.of('XYZ'), 50, 720, null],
        }),
      ),
    ]),
  );
  for (const [y, width] of [
    [595, 150],
    [575, 70],
  ])
    a.node.Annots().push(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [50, y, 50 + width, y + 18],
          A: { S: 'URI', URI: PDFString.of('https://example.org/wrapped') },
        }),
      ),
    );
  const root = doc.context.register(doc.context.obj({ Type: 'Outlines' })),
    item = doc.context.register(
      doc.context.obj({
        Title: PDFString.of('Chapter Beta'),
        Parent: root,
        Dest: [b.ref, PDFName.of('Fit')],
      }),
    );
  doc.context.lookup(root).set(PDFName.of('First'), item);
  doc.context.lookup(root).set(PDFName.of('Last'), item);
  doc.context.lookup(root).set(PDFName.of('Count'), doc.context.obj(1));
  doc.catalog.set(PDFName.of('Outlines'), root);
  return Buffer.from(await doc.save());
}
test('search, outline, links, reordered bookmarks, copy/export and workspace restore', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles({
    name: 'navigation.pdf',
    mimeType: 'application/pdf',
    buffer: await fixture(),
  });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: '搜索文档文字' }).fill('beta');
  await expect(page.locator('.document-search-results button')).toHaveCount(1);
  const row = page.locator('.document-search-results button').first();
  await expect(row).toHaveCSS('height', '60px');
  await row.hover();
  await expect(page.getByRole('tooltip')).toContainText('Second page beta target');
  await expect(page.getByRole('tooltip').locator('mark')).toHaveText('beta');
  const sidebar = page.locator('.sidebar'),
    initialWidth = (await sidebar.boundingBox())!.width;
  const grip = page.getByRole('separator', { name: '调整侧栏宽度' }),
    box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + 80, { steps: 5 });
  await page.mouse.up();
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(initialWidth + 90);
  await page.locator('.document-search-results button').click();
  await expect(page.locator('.pdf-search-mark')).toHaveCount(1);
  await page.getByRole('button', { name: '书签', exact: true }).click();
  await page.getByRole('button', { name: '添加当前页书签' }).click();
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.page-card.selected')).toHaveAttribute('data-page-index', '1');
  await page.getByRole('button', { name: '书签', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '书签名称' })).toHaveCount(0);
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await expect(page.locator('.page-card.selected')).toHaveAttribute('data-page-index', '1');
  await page.keyboard.press('Control+y');
  await expect(page.locator('.page-card.selected')).toHaveAttribute('data-page-index', '1');
  await page.getByRole('button', { name: '书签', exact: true }).click();
  await page.getByRole('textbox', { name: '书签名称' }).fill('My beta');
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('button', { name: 'Chapter Beta', exact: true }).click();
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await expect(page.getByRole('button', { name: '跳转到引用' })).toHaveCSS('min-height', '0px');
  await expect(page.getByRole('button', { name: '跳转到引用' })).toHaveCSS('height', '25px');
  await expect(
    page.locator('a.pdf-document-link[href="https://example.org/plain"]'),
  ).toHaveAttribute('href', 'https://example.org/plain');
  const wrapped = page.locator('a.pdf-document-link[href="https://example.org/wrapped"]');
  await expect(wrapped).toHaveCount(2);
  await wrapped.first().hover();
  await expect(page.locator('a.pdf-document-link.link-highlighted')).toHaveCount(2);
  await page.getByRole('button', { name: '跳转到引用' }).click();
  await page.getByRole('button', { name: '复制当前页', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.page-card')).toHaveCount(3);
  await page.getByRole('button', { name: '第 2 页', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '上移', exact: true }).click();
  await page.getByRole('button', { name: '书签', exact: true }).click();
  await page.getByRole('button', { name: '打开书签' }).click();
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await expect(page.locator('.page-card.selected')).toHaveAttribute('data-page-index', '0');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
  const file = await downloaded;
  const { readFile } = await import('node:fs/promises');
  const exported = await PDFDocument.load(await readFile((await file.path())!));
  expect(exported.getPageCount()).toBe(3);
  const { PDFDict } = createRequire(import.meta.url)('pdf-lib');
  const outlines = exported.catalog.lookup(PDFName.of('Outlines'), PDFDict),
    last = outlines.lookup(PDFName.of('Last'), PDFDict);
  expect(last.lookup(PDFName.of('Title')).decodeText()).toBe('My beta');
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(initialWidth + 90);
  await page.getByRole('button', { name: '书签', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '书签名称' })).toHaveValue('My beta');
  expect(errors).toEqual([]);
  await page.screenshot({ path: '.cache/navigation-ui-bookmarks.png' });
  await page.setViewportSize({ width: 600, height: 1000 });
  await page.evaluate(() => {
    localStorage.setItem('surfacetab.night', 'true');
    localStorage.setItem('surfacetab.locale', 'en');
  });
  await page.reload();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: 'Search document text' }).fill('beta');
  await expect(page.locator('.document-search-results button')).toHaveCount(2);
  await page.screenshot({ path: '.cache/navigation-ui-search-portrait-night.png' });
});
test('undo and redo on the right-hand page keep the current spread', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'spread.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '第 2 页', exact: true }).click();
  await page.getByRole('button', { name: '书签', exact: true }).click();
  await page.getByRole('button', { name: '添加当前页书签' }).click();
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await page.getByRole('button', { name: '第 1 页', exact: true }).click();
  await page.getByRole('button', { name: '双页预览', exact: true }).click();
  const indices = () =>
    page
      .locator('.reading-card')
      .evaluateAll((nodes) => nodes.map((el) => (el as HTMLElement).dataset.pageIndex));
  await page.keyboard.press('Control+z');
  await expect(page.locator('.page-card.selected')).toHaveAttribute('data-page-index', '0');
  await page.keyboard.press('Control+y');
  await expect(page.locator('.page-card.selected')).toHaveAttribute('data-page-index', '0');
  await expect.poll(indices).toEqual(['0', '1']);
});
