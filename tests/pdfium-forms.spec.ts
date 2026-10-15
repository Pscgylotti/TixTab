import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, rgb, degrees } = createRequire(import.meta.url)('pdf-lib');
test('static form text and checkboxes render across page rotations and release their environments', async ({
  page,
}) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    form = doc.getForm();
  for (let i = 0; i < 4; i++) {
    const p = doc.addPage([400, 600]);
    p.setRotation(degrees(i * 90));
    const field = form.createTextField(`value${i}`);
    field.setText('ABCDE123');
    field.addToPage(p, { x: 40, y: 300, width: 180, height: 40, font, textColor: rgb(1, 0, 0) });
    const checkbox = form.createCheckBox(`checked${i}`);
    checkbox.addToPage(p, { x: 240, y: 300, width: 30, height: 30 });
    checkbox.check();
  }
  form.updateFieldAppearances(font);
  const checkedBytes = Array.from(await doc.save());
  for (let i = 0; i < 4; i++) form.getCheckBox(`checked${i}`).uncheck();
  form.updateFieldAppearances(font);
  const uncheckedBytes = Array.from(await doc.save());
  await page.goto('/');
  const result = await page.evaluate(
    async ({ checkedBytes, uncheckedBytes }) => {
      const { loadPdf } = await import('/src/pdf.ts'),
        { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
      const rows = [];
      for (let cycle = 0; cycle < 2; cycle++) {
        for (const [checked, bytes] of [
          [true, checkedBytes],
          [false, uncheckedBytes],
        ] as const) {
          const pdf = await loadPdf(new Uint8Array(bytes));
          try {
            for (let i = 0; i < 4; i++) {
              const p = await pdf.getPage(i + 1),
                viewport = p.getViewport({ scale: 1 }),
                c = document.createElement('canvas');
              c.width = viewport.width;
              c.height = viewport.height;
              await p.render({ canvas: c, viewport }).promise;
              const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
              let red = 0,
                dark = 0;
              for (let j = 0; j < pixels.length; j += 4) {
                if (pixels[j] > 150 && pixels[j + 1] < 60 && pixels[j + 2] < 60) red++;
                if (pixels[j] < 60 && pixels[j + 1] < 60 && pixels[j + 2] < 60) dark++;
              }
              await p.render({ canvas: c, viewport, widgets: false }).promise;
              const clean = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
              rows.push({ checked, red, dark, blank: clean.every((v) => v === 255) });
              c.width = c.height = 1;
            }
          } finally {
            await pdf.destroy();
          }
        }
      }
      for (let n = 0; n < 100 && getPdfiumStats().pending; n++)
        await new Promise((r) => setTimeout(r, 10));
      return { rows, stats: getPdfiumStats() };
    },
    { checkedBytes, uncheckedBytes },
  );
  for (const row of result.rows) {
    expect(row.red).toBeGreaterThan(50);
    expect(row.blank).toBe(true);
  }
  const checked = result.rows.filter((r) => r.checked),
    unchecked = result.rows.filter((r) => !r.checked);
  // Compare the same widget with and without its check mark. At scale 1 the
  // valid anti-aliased mark has 41–42 dark pixels; a global >50 count was brittle.
  for (let i = 0; i < checked.length; i++)
    expect(checked[i].dark).toBeGreaterThan(unchecked[i].dark);
  expect(result.stats).toMatchObject({
    workers: 1,
    documents: 0,
    pending: 0,
    sessions: 0,
    initializations: 1,
  });
});
