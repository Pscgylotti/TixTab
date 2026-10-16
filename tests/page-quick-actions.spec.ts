import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++)
    doc.addPage([400, 600]).drawText('Original PDF text', { x: 50, y: 500, font, size: 16 });
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'page-actions.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const store = await import('/src/workspaceStore.ts' as string);
    const meta = (await store.listWorkspace()).documents.find(
      (d: { name: string }) => d.name === 'page-actions',
    );
    return meta ? (await store.loadWorkspaceDocument(meta.id, false)).notebook : null;
  });
}
async function menu(page: Page) {
  await page
    .locator('.statusbar')
    .getByRole('button', { name: '页面快捷操作', exact: true })
    .click();
  return page.getByRole('dialog', { name: '页面快捷操作', exact: true });
}
test('quick actions clear annotations with undo while preserving PDF, duplicate/insert/delete near the footer', async ({
  page,
}) => {
  await open(page);
  const editor = page.locator('.page-editor').first(),
    box = (await editor.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await stored(page))?.pages[0].strokes.length).toBe(1);
  await page.getByRole('button', { name: '便签', exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.up();
  await expect(page.getByLabel('便签内容')).toBeVisible();
  await page.getByLabel('便签内容').fill('Keep on undo');
  await page.getByRole('button', { name: '关闭便签', exact: true }).click();
  const panel = await menu(page);
  expect(await panel.getByRole('button').count()).toBe(5);
  const b = (await panel.boundingBox())!,
    footer = (await page.locator('.statusbar').boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(footer.y + 8);
  await panel.getByRole('button', { name: '删除当前页标注', exact: true }).click();
  await expect
    .poll(async () => {
      const p = (await stored(page))?.pages[0];
      return [p?.strokes.length, p?.reviews?.length];
    })
    .toEqual([0, 0]);
  await page.getByRole('button', { name: '选文', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Original PDF text');
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => {
      const p = (await stored(page))?.pages[0];
      return [p?.strokes.length, p?.reviews?.[0]?.text];
    })
    .toEqual([1, 'Keep on undo']);
  await (await menu(page)).getByRole('button', { name: '复制当前页', exact: true }).click();
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(page.locator('.page-card')).toHaveCount(3);
  await (await menu(page)).getByRole('button', { name: '插入空白页', exact: true }).click();
  const blank = page.getByRole('dialog', { name: '插入空白页', exact: true });
  await blank.getByRole('button', { name: '格子', exact: true }).click();
  await blank.getByRole('button', { name: '插入页面', exact: true }).click();
  await expect(page.locator('.page-card')).toHaveCount(4);
  await (await menu(page)).getByRole('button', { name: '删除当前页', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '删除页面' })
    .getByRole('button', { name: '确认删除' })
    .click();
  await expect(page.locator('.page-card')).toHaveCount(3);
});
test('ink preview radius follows tool, pressure and zoom in all views, without the crosshair', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('tixtab.inkSize.pen', '6'));
  await open(page);
  for (const view of ['单页标注', '连续页面预览', '双页预览']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.getByRole('button', { name: '钢笔', exact: true }).click();
    const editor = page.locator('.page-editor').first();
    const preview = async (pressure: number, pointerType = 'pen') => {
      const b = (await editor.boundingBox())!;
      await editor.dispatchEvent('pointermove', {
        pointerType,
        pointerId: 42,
        pressure,
        buttons: pressure ? 1 : 0,
        clientX: b.x + 80,
        clientY: b.y + 90,
      });
    };
    await preview(0.1);
    const circle = page.locator('.pdf-ink-cursor').filter({ visible: true });
    await expect(circle).toBeVisible();
    const low = Number(await circle.getAttribute('data-paper-radius'));
    await preview(0.9);
    expect(Number(await circle.getAttribute('data-paper-radius'))).toBeGreaterThan(low * 2);
    const before = Number(await circle.getAttribute('data-screen-radius')),
      scale = (await editor.boundingBox())!.width;
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await preview(0.9);
    expect(Number(await circle.getAttribute('data-screen-radius')) / before).toBeCloseTo(
      (await editor.boundingBox())!.width / scale,
      2,
    );
    expect(await editor.evaluate((el) => getComputedStyle(el).cursor)).toBe('none');
    await preview(0, 'touch');
    await expect(circle).toBeHidden();
    await page.getByRole('button', { name: '移动', exact: true }).click();
    await preview(0, 'mouse');
    await expect(circle).toBeHidden();
  }
});
