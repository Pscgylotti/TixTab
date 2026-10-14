import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, rgb, degrees } = createRequire(import.meta.url)('pdf-lib');
test('half-page completion preserves full-raster pixels with rotation, transparency and night colour', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto('/');
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 97;
    c.height = 63;
    const ctx = c.getContext('2d')!;
    for (let y = 0; y < 63; y++)
      for (let x = 0; x < 97; x++) {
        ctx.fillStyle = `rgba(${x * 2},${y * 4},170,${((x + y) % 7) / 6})`;
        ctx.fillRect(x, y, 1, 1);
      }
    return c.toDataURL();
  });
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    image = await doc.embedPng(png);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([595.25, 841.75]);
    for (let y = 20; y < 830; y += 23)
      p.drawText('Half-page quality: complex text 123', { x: 30, y, size: 14.375, font });
    p.drawRectangle({
      x: 40.25,
      y: 310.125,
      width: 300.5,
      height: 320.75,
      color: rgb(0.2, 0.6, 0.9),
      opacity: 0.35,
    });
    p.drawImage(image, {
      x: 140.375,
      y: 300.125,
      width: 220.25,
      height: 220.75,
      rotate: degrees(13),
    });
    if (i) {
      p.setCropBox(13.25, 17.75, 561.5, 799.25);
      p.setRotation(degrees(90));
    }
  }
  const rows = await page.evaluate(
    async (base64) => {
      const { loadPdf } = await import('/src/pdf.ts' as string),
        cache = await import('/src/pdfRenderCache.ts' as string),
        { setPowerMode } = await import('/src/appearance.ts' as string);
      setPowerMode('quality');
      const pdf = await loadPdf(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
        rows = [];
      const pixels = (canvas: HTMLCanvasElement) =>
        canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let sourceIndex = 0; sourceIndex < 2; sourceIndex++)
        for (const night of [false, true])
          for (const scale of [0.7, 1.25, 2])
            for (const side of ['top', 'bottom']) {
              cache.setPdfViewCacheKey(pdf, `reference:${sourceIndex}:${night}:${scale}:${side}`);
              const reference = await cache.requestPdfBitmap(pdf, sourceIndex, scale, 0, night)
                  .promise,
                expected = pixels(reference);
              cache.setPdfViewCacheKey(pdf, `half:${sourceIndex}:${night}:${scale}:${side}`);
              const size = (await pdf.getPage(sourceIndex + 1)).getViewport({ scale: 1 });
              await cache.requestPdfHalf(
                pdf,
                sourceIndex,
                scale,
                size.width,
                size.height,
                side,
                night,
              ).promise;
              const actual = pixels(
                await cache.requestPdfBitmap(pdf, sourceIndex, scale, 0, night).promise,
              );
              let different = 0,
                max = 0;
              for (let i = 0; i < actual.length; i++) {
                const d = Math.abs(actual[i] - expected[i]);
                if (d) different++;
                max = Math.max(max, d);
              }
              rows.push({ sourceIndex, night, scale, side, different, max });
            }
      await pdf.destroy();
      return rows;
    },
    Buffer.from(await doc.save()).toString('base64'),
  );
  await test.info().attach('half-page-pixels.json', {
    body: JSON.stringify(rows, null, 2),
    contentType: 'application/json',
  });
  expect(rows).toHaveLength(24);
  expect(rows.filter((r) => r.different)).toEqual([]);
});
