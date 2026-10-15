import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, PDFName, PDFNumber, PDFString, PDFHexString, degrees } =
  createRequire(import.meta.url)('pdf-lib');
test('native page geometry/text/navigation match source geometry; bitmap inventory decodes no pixels', async ({
  page,
}) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const p = doc.addPage([600, 800]);
    pages.push(p);
    p.setCropBox(40, 60, 400, 600);
    p.setRotation(degrees(i * 90));
    p.node.set(PDFName.of('UserUnit'), PDFNumber.of([1, 2, 0.5, 3][i]));
    p.drawText('Native selection words 123', { x: 60, y: 550, font, size: 18 });
    p.drawImage(image, { x: 220, y: 300, width: 100, height: 80 });
    p.node.set(
      PDFName.of('Annots'),
      doc.context.obj([
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [60, 500, 160, 520],
            A: { S: 'URI', URI: PDFString.of('https://example.com/') },
          }),
        ),
      ]),
    );
  }
  const destination = doc.context.obj([pages[1].ref, PDFName.of('XYZ'), null, 550, null]);
  doc.catalog.set(PDFName.of('Dests'), doc.context.obj({ target: destination }));
  const root = doc.context.register(doc.context.obj({ Type: 'Outlines' }));
  const item = doc.context.register(
    doc.context.obj({
      Title: PDFHexString.fromText('目录 Chapter'),
      Parent: root,
      Dest: destination,
    }),
  );
  doc.context.lookup(root).set(PDFName.of('First'), item);
  doc.context.lookup(root).set(PDFName.of('Last'), item);
  doc.context.lookup(root).set(PDFName.of('Count'), PDFNumber.of(1));
  doc.catalog.set(PDFName.of('Outlines'), root);
  await page.goto('/');
  const result = await page.evaluate(
    async (bytes) => {
      const { loadPdfiumDocument } = await import('/src/pdfiumDocument.ts');
      const { getPdfImages } = await import('/src/pdfNight.ts');
      const { inspectBitmapPages } = await import('/src/bitmapOcr.ts');
      const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
      const { renderPdfTextDom } = await import('/src/pdfTextDom.ts');
      const native = await loadPdfiumDocument(new Uint8Array(bytes)),
        geometry = [],
        text = [];
      for (let i = 1; i <= 4; i++) {
        const a = await native.getPage(i);
        for (const dontFlip of [false, true]) {
          const options = { scale: 1.25, offsetX: 3, offsetY: 5, dontFlip },
            av = a.getViewport(options),
            scale = 1.25 * [1, 2, 0.5, 3][i - 1];
          const s = scale;
          const transforms = dontFlip
            ? [
                [s, 0, 0, s, 3 - 40 * s, 5 - 60 * s],
                [0, s, -s, 0, 3 + 660 * s, 5 - 40 * s],
                [-s, 0, 0, -s, 3 + 440 * s, 5 + 660 * s],
                [0, -s, s, 0, 3 - 60 * s, 5 + 440 * s],
              ]
            : [
                [s, 0, 0, -s, 3 - 40 * s, 5 + 660 * s],
                [0, s, s, 0, 3 - 60 * s, 5 - 40 * s],
                [-s, 0, 0, s, 3 + 440 * s, 5 - 60 * s],
                [0, -s, -s, 0, 3 + 660 * s, 5 + 440 * s],
              ];
          geometry.push({
            actual: [av.width, av.height, ...av.transform],
            expected: [
              ((i - 1) % 2 ? 600 : 400) * s,
              ((i - 1) % 2 ? 400 : 600) * s,
              ...transforms[i - 1],
            ],
          });
        }
        const at = await a.getTextContent();
        const root = document.createElement('div');
        root.className = 'textLayer';
        document.body.append(root);
        try {
          renderPdfTextDom(root, at, a.getViewport({ scale: 1 }));
          if (!root.querySelector('.pdf-text-run')) throw Error('selectable text missing');
        } finally {
          root.remove();
        }
        const ai = at.items.filter((v: any) => 'str' in v);
        text.push({
          actual: ai.map((v: any) => v.str).join(''),
          expected: 'Native selection words 123',
          transform: ai[0].transform,
          expectedTransform: [18, 0, 0, 18, 60, 550],
          width: ai[0].width,
          expectedWidth: 214.452,
        });
      }
      const outline = await native.getOutline(),
        dest = await native.getDestination('target'),
        links = await (await native.getPage(1)).getAnnotations();
      try {
        const inventory = await inspectBitmapPages(
          Array.from(
            { length: 4 },
            (_, i) =>
              ({ id: String(i), sourceIndex: i, images: [], bitmapOcr: [], strokes: [] }) as any,
          ),
          native,
          new AbortController().signal,
        );
        const polygons = await getPdfImages(native, 0);
        await native.destroy();
        for (let i = 0; i < 200 && getPdfiumStats().documents; i++)
          await new Promise((r) => setTimeout(r, 10));
        return {
          geometry,
          text,
          outline,
          dest,
          links,
          inventory: { total: inventory.total, parsed: inventory.parsed },
          polygons,
          after: getPdfiumStats(),
        };
      } finally {
        await native.destroy();
      }
    },
    Array.from(await doc.save()),
  );
  for (const row of result.geometry)
    row.actual.forEach((n, i) => expect(n).toBeCloseTo(row.expected[i], 8));
  for (const row of result.text) {
    expect(row.actual).toBe(row.expected);
    row.transform.forEach((v: number, i: number) =>
      expect(v).toBeCloseTo(row.expectedTransform[i], 3),
    );
    // Native loose glyph bounds include ink beyond the font advance box.
    expect(Math.abs(row.width - row.expectedWidth)).toBeLessThan(1);
  }
  expect(result.dest).toEqual([1, { name: 'XYZ' }, null, 550, null]);
  expect(result.outline?.[0].title).toBe('目录 Chapter');
  expect(result.links[0]).toMatchObject({ rect: [60, 500, 160, 520], url: 'https://example.com/' });
  expect(result.inventory).toEqual({ total: 4, parsed: 0 });
  expect(result.polygons).toEqual([[220, 300, 320, 300, 320, 380, 220, 380]]);
  expect(result.after).toMatchObject({ documents: 0, sessions: 0, workers: 1, pending: 0 });
});
