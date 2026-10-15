import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { readFile, access, writeFile } from 'node:fs/promises';
test('a real Type1 subset retains glyphs in PDFium after appending s', async ({ page }) => {
  const source = '.cache/page-editing/heading-source.pdf',
    edited = '.cache/page-editing/heading-cold.pdf';
  test.skip(
    !(await access(source).then(
      () => true,
      () => false,
    )),
    'Private regression fixture is local only.',
  );
  await page.goto('/');
  const result = await page.evaluate(
    async ({ source, edited }) => {
      const { loadPdf, destroyPdf } = await import('/src/pdf.ts' as string);
      const draw = async (data: number[]) => {
        const doc = await loadPdf(new Uint8Array(data));
        try {
          const p = await doc.getPage(1),
            viewport = p.getViewport({ scale: 3 }),
            c = document.createElement('canvas');
          c.width = viewport.width;
          c.height = viewport.height;
          await p.render({ canvas: c, viewport }).promise;
          const pixels = Array.from(
            c.getContext('2d')!.getImageData(135.4 * 3, 82 * 3, 40 * 3, 14 * 3).data,
          );
          const text = (await p.getTextContent()).items.map((x: any) => x.str ?? '').join(' ');
          const image = c.toDataURL();
          c.width = c.height = 1;
          return { pixels, text, image };
        } finally {
          await destroyPdf(doc);
        }
      };
      const a = await draw(source),
        b = await draw(edited);
      return {
        original: a.image,
        edited: b.image,
        text: b.text,
        differences: a.pixels.filter((x, i) => Math.abs(x - b.pixels[i]) > 16).length,
        size: a.pixels.length,
      };
    },
    { source: Array.from(await readFile(source)), edited: Array.from(await readFile(edited)) },
  );
  await writeFile(
    '.cache/page-editing/pdfium-heading-original.png',
    Buffer.from(result.original.split(',')[1], 'base64'),
  );
  await writeFile(
    '.cache/page-editing/pdfium-heading-edited.png',
    Buffer.from(result.edited.split(',')[1], 'base64'),
  );
  expect(result.text).toContain('HRESHOLDs');
  const { PDFDocument, PDFName, PDFDict } = createRequire(import.meta.url)('pdf-lib');
  const doc = await PDFDocument.load(await readFile(edited));
  const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict);
  const name = fonts.keys().find((name: any) => name.decodeText().startsWith('TixTabEdit'));
  expect(fonts.lookup(name, PDFDict).lookup(PDFName.of('Subtype'), PDFName).decodeText()).toBe(
    'Type1',
  );
});
