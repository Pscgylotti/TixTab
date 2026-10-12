import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');

for (const mode of ['单页标注', '连续页面预览', '双页预览']) {
  test(`missing pen release cannot freeze PDF pages and thumbnails: ${mode}`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 4; i++)
      pdf.addPage([600, 800]).drawText(`Recover page ${i + 1}`, { x: 60, y: 700, font });
    // No pointerup/cancel/lostcapture follows this event, as with consumed native
    // input. Importing does not require another click to recover the scheduler.
    await page.evaluate(() =>
      document.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 888,
          pointerType: 'pen',
          buttons: 1,
          bubbles: true,
        }),
      ),
    );
    await page.locator('input[type=file]').setInputFiles({
      name: 'recover.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(page.locator('.busy-overlay')).toHaveCount(0);
    // Imports intentionally restore a new document's default view. Set its view
    // with a click-only event so no real pointerup masks the missing-release case.
    await page
      .getByRole('button', { name: mode, exact: true })
      .evaluate((el: HTMLButtonElement) => el.click());
    const selector = mode === '单页标注' ? '.pdf-layer' : '.reading-pdf';
    await expect
      .poll(
        () =>
          page
            .locator(selector)
            .first()
            .evaluate((c: HTMLCanvasElement) => c.width),
        { timeout: 6000 },
      )
      .toBeGreaterThan(100);
    await expect
      .poll(
        () =>
          page
            .locator('.page-thumbnail canvas')
            .first()
            .evaluate((c: HTMLCanvasElement) => c.width),
        { timeout: 6000 },
      )
      .toBeGreaterThan(100);
    await expect(page.locator(selector).first()).toBeVisible();
  });
}
