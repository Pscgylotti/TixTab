import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');

for (const mode of ['单页标注', '连续页面预览', '双页预览', 'scratch']) {
  test(`${mode}: object tool selects, moves, resizes and deletes review notes with undo`, async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 600]);
    pdf.addPage([400, 600]);
    await page.locator('input[type=file]').setInputFiles({
      name: 'Review objects.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    if (mode === 'scratch') {
      await page.getByRole('button', { name: '草稿', exact: true }).click();
      await page.getByRole('button', { name: '进入草稿模式', exact: true }).click();
      await page.getByRole('button', { name: '隐藏原 PDF', exact: true }).click();
      await page.keyboard.press('Escape');
    } else await page.getByRole('button', { name: mode, exact: true }).click();
    const scope = page.locator(mode === 'scratch' ? '.scratch-viewport' : '.canvas-container');
    const paper = page
      .locator(
        mode === 'scratch' ? '.canvas-container' : '.paper:not(.scratch-paper),.reading-paper',
      )
      .first();
    const r = (await paper.boundingBox())!;
    const x = r.x + (mode === 'scratch' ? 120 : r.width * 0.3),
      y = r.y + (mode === 'scratch' ? 180 : r.height * 0.35);
    await page.getByRole('button', { name: '便签', exact: true }).click();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 90, y + 55, { steps: 4 });
    await page.mouse.up();
    await page.getByLabel('便签内容', { exact: true }).fill('Keep review text');
    await page.getByRole('button', { name: '对象', exact: true }).click();
    if (mode === '单页标注') {
      await paper.evaluate(async (element) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 30;
        canvas.getContext('2d')!.fillRect(0, 0, 30, 30);
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
        const data = new DataTransfer();
        data.items.add(new File([blob], 'keep.png', { type: 'image/png' }));
        element.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await expect(page.locator('.placed-object.chosen')).toHaveCount(1);
    }
    await page.keyboard.press('Escape');
    const anchor = scope.locator('.review-anchor').first();
    await anchor.click();
    await expect(anchor).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.placed-object.chosen')).toHaveCount(0);
    await expect(scope.locator('.review-resize-handle')).toHaveCount(4);
    await expect(scope.locator('.review-card textarea')).toHaveCount(0);
    const before = (await anchor.boundingBox())!;
    await page.mouse.move(before.x + 15, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x + 45, before.y + 40, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await anchor.boundingBox())!.x).toBeCloseTo(before.x + 30, 0);
    const moved = (await anchor.boundingBox())!;
    const handle = scope.locator('.review-resize-handle.se').first();
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2 + 15, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => (await anchor.boundingBox())!.width)
      .toBeGreaterThan(moved.width + 15);
    await page
      .locator('.object-inspector')
      .getByRole('button', { name: '删除选中对象', exact: true })
      .click();
    await expect(scope.locator('.review-anchor')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(anchor).toHaveCount(1);
    await anchor.click();
    await expect(scope.locator('.review-card')).toContainText('Keep review text');
    await page.keyboard.press('Delete');
    await expect(scope.locator('.review-anchor')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await anchor.click();
    await scope
      .locator('.review-card')
      .getByRole('button', { name: '删除便签', exact: true })
      .click();
    await expect(scope.locator('.review-anchor')).toHaveCount(0);
    await expect(page.locator('.save-state')).toContainText('已自动保存');
    await page.reload();
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    await expect(page.locator('.review-anchor')).toHaveCount(0);
    if (mode === '单页标注') await expect(page.locator('.placed-object')).toHaveCount(1);
  });
}
