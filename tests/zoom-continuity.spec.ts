import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, rgb } = createRequire(import.meta.url)('pdf-lib');

for (const backend of ['pdfjs', 'pdfium'])
  for (const view of ['单页标注', '连续页面预览', '双页预览'])
    test(`zoom retains a bounded CPU transition after raster loss and replaces it when ready: ${backend}/${view}`, async ({
      page,
    }) => {
      await page.addInitScript(
        (backend) => localStorage.setItem('tixtab.pdfRenderBackend', backend),
        backend,
      );
      await page.goto('/');
      await expect(page.getByRole('button', { name: '打开', exact: true })).toBeEnabled();
      const doc = await PDFDocument.create(),
        font = await doc.embedFont(StandardFonts.Helvetica);
      for (let i = 0; i < 3; i++) {
        const p = doc.addPage([600, 800]);
        p.drawRectangle({ x: 30, y: 40, width: 500, height: 700, color: rgb(0.2, 0.5, 0.7) });
        p.drawText('Zoom continuity', { x: 60, y: 500, size: 24, font });
      }
      await page.locator('input[type=file]').setInputFiles({
        name: 'zoom-continuity.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await doc.save()),
      });
      await expect(page.locator('.busy-overlay')).toHaveCount(0);
      await page.getByRole('button', { name: view, exact: true }).click();
      const selector = view === '单页标注' ? '.pdf-layer' : '.reading-pdf';
      await expect(page.locator(`${selector}[data-pdf-backend=${backend}]`).first()).toBeVisible();
      await page.getByRole('button', { name: '放大', exact: true }).click();
      const transition = await page
        .locator(selector)
        .first()
        .evaluate((canvas: HTMLCanvasElement) => {
          const host = canvas.parentElement!;
          canvas.dispatchEvent(new Event('contextlost'));
          const next = host.querySelector('canvas') as HTMLCanvasElement | null;
          // The old canvas is detached by loss handling; inspect its former host.
          return next
            ? { preview: next.dataset.transitionPreview, width: next.width, height: next.height }
            : null;
        });
      expect(transition?.preview).toBe('true');
      // Recovery needs no readable GPU surface: its CPU backup was made at zoom start.
      const current = page.locator(selector).first();
      const pixels = await current.evaluate((c: HTMLCanvasElement) => ({
        width: c.width,
        height: c.height,
        alpha: c
          .getContext('2d')!
          .getImageData(0, 0, c.width, c.height)
          .data.some((v, i) => i % 4 === 3 && v > 0),
        preview: c.dataset.transitionPreview,
      }));
      expect(pixels.alpha, JSON.stringify({ transition, pixels })).toBe(true);
      if (pixels.preview) expect(pixels.width * pixels.height).toBeLessThanOrEqual(160000);
      await expect(
        page
          .locator(`${selector}[data-pdf-backend=${backend}]:not([data-transition-preview])`)
          .first(),
      ).toBeVisible();
    });

test('settings omit the desktop shortcut action even when the bridge supports it', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.surfaceDesktop = {
      onFullscreen: () => () => {},
      createDesktopShortcut: async () => ({ ok: true }),
    } as any;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送快捷方式到桌面', exact: true })).toHaveCount(
    0,
  );
});
