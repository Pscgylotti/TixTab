import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, PDFName, PDFNumber, PDFString, PDFHexString, degrees } =
  createRequire(import.meta.url)('pdf-lib');
test('native page geometry/text/navigation agree with PDF.js without opening a second parser; bitmap inventory decodes no pixels', async ({
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
      const { loadLegacyPdf, getLegacyPdfStats } = await import('/src/pdfLegacy.ts');
      const { loadPdfiumDocument } = await import('/src/pdfiumDocument.ts');
      const { getPdfImages } = await import('/src/pdfNight.ts');
      const { inspectBitmapPages } = await import('/src/bitmapOcr.ts');
      const { setPdfRenderBackend } = await import('/src/appearance.ts');
      const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
      const { renderPdfTextDom } = await import('/src/pdfTextDom.ts');
      const reference = await loadLegacyPdf(new Uint8Array(bytes));
      setPdfRenderBackend('pdfium');
      const native = await loadPdfiumDocument(new Uint8Array(bytes)),
        geometry = [],
        text = [];
      const opens = getLegacyPdfStats().opens;
      for (let i = 1; i <= 4; i++) {
        const a = await native.getPage(i),
          b = await reference.getPage(i);
        for (const dontFlip of [false, true]) {
          const options = { scale: 1.25, offsetX: 3, offsetY: 5, dontFlip },
            av = a.getViewport(options),
            bv = b.getViewport(options);
          geometry.push({
            actual: [av.width, av.height, ...av.transform],
            expected: [bv.width, bv.height, ...bv.transform],
          });
        }
        const at = await a.getTextContent(),
          bt = await b.getTextContent();
        const root = document.createElement('div');
        root.className = 'textLayer';
        document.body.append(root);
        try {
          renderPdfTextDom(root, at, a.getViewport({ scale: 1 }));
          if (!root.querySelector('.pdf-text-run')) throw Error('selectable text missing');
        } finally {
          root.remove();
        }
        const ai = at.items.filter((v: any) => 'str' in v),
          bi = bt.items.filter((v: any) => 'str' in v);
        text.push({
          actual: ai.map((v: any) => v.str).join(''),
          expected: bi.map((v: any) => v.str).join(''),
          transform: ai[0].transform,
          expectedTransform: bi[0].transform,
          width: ai[0].width,
          expectedWidth: bi[0].width,
        });
      }
      const outline = await native.getOutline(),
        dest = await native.getDestination('target'),
        links = await (await native.getPage(1)).getAnnotations();
      const nativeOnlyOpens = getLegacyPdfStats().opens - opens;
      // Count traffic from every PDF.js worker, including the lazily opened index
      // document. Do not rely on absence of images in the native facade itself.
      const NativeWorker = window.Worker;
      let decoded = 0,
        fonts = 0;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('message', ({ data }) => {
            if (data.action === 'obj' && data.data?.[2] === 'Image') decoded++;
            if (data.action === 'commonobj' && data.data?.[1] === 'Image') decoded++;
            if (data.action === 'commonobj' && data.data?.[1] === 'Font') fonts++;
          });
        }
      };
      try {
        for (let i = 1; i <= 4; i++)
          (await native.getPage(i)).getOperatorList = () => {
            throw Error('full operator list forbidden in inventory');
          };
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
        await reference.destroy();
        for (let i = 0; i < 200 && getPdfiumStats().documents; i++)
          await new Promise((r) => setTimeout(r, 10));
        return {
          geometry,
          text,
          outline,
          dest,
          links,
          nativeOnlyOpens,
          inventory: { total: inventory.total, parsed: inventory.parsed },
          decoded,
          fonts,
          polygons,
          after: getPdfiumStats(),
        };
      } finally {
        window.Worker = NativeWorker;
        await native.destroy();
        await reference.destroy();
      }
    },
    Array.from(await doc.save()),
  );
  for (const row of result.geometry) expect(row.actual).toEqual(row.expected);
  for (const row of result.text) {
    expect(row.actual).toBe(row.expected);
    row.transform.forEach((v: number, i: number) =>
      expect(v).toBeCloseTo(row.expectedTransform[i], 3),
    );
    expect(row.width).toBeCloseTo(row.expectedWidth, 0);
  }
  expect(result.nativeOnlyOpens).toBe(0);
  expect(result.dest).toEqual([1, { name: 'XYZ' }, null, 550, null]);
  expect(result.outline?.[0].title).toBe('目录 Chapter');
  expect(result.links[0]).toMatchObject({ rect: [60, 500, 160, 520], url: 'https://example.com/' });
  expect(result.inventory).toEqual({ total: 4, parsed: 0 });
  expect(result.decoded).toBe(0);
  expect(result.fonts).toBe(0);
  expect(result.polygons).toEqual([[220, 300, 320, 300, 320, 380, 220, 380]]);
  expect(result.after).toMatchObject({ documents: 0, sessions: 0, workers: 1, pending: 0 });
});
