import { expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { sourceImages } from './pdfSourceImages';
import { polygonBox } from './pdfNightGeometry';
async function index(doc: PDFDocument) {
  return sourceImages(await PDFDocument.load(await doc.save()));
}
it('ignores dense vector coordinates while preserving signed fractional image transforms and cancellation', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 600]);
  const image = doc.context.register(
    doc.context.stream(new Uint8Array([1, 2, 3]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  );
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { I: image } }));
  page.node.addContentStream(
    doc.context.register(
      doc.context.flateStream(
        '0.125 -2.75 3.5 .5 6 7 c\n'.repeat(20000) + 'q +10.25 0 0 -20.5 -.125 +40.25 cm /I Do Q',
      ),
    ),
  );
  const parsed = await PDFDocument.load(await doc.save());
  const result = await sourceImages(parsed);
  expect(result.images[0]).toHaveLength(1);
  expect(result.images[0][0].polygon).toEqual([
    -0.125, 40.25, 10.125, 40.25, 10.125, 19.75, -0.125, 19.75,
  ]);
  let checks = 0;
  await expect(
    sourceImages(parsed, () => {
      if (++checks > 1) throw Error('cancelled');
    }),
  ).rejects.toThrow('cancelled');
});
it('keeps drawing state across streams, recurses inherited form resources and excludes stencil masks', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 600]);
  const image = doc.context.register(
    doc.context.stream(new Uint8Array([250, 0, 0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  );
  const mask = doc.context.register(
    doc.context.stream(new Uint8Array([255]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 8,
      Height: 1,
      ImageMask: true,
      BitsPerComponent: 1,
    }),
  );
  const form = doc.context.register(
    doc.context.flateStream('/I Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 1, 1],
      Matrix: [2, 0, 0, 3, 1, 2],
    }),
  );
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { I: image, M: mask, F: form } }),
  );
  for (const content of ['q 100 0 0 50 20 30 cm (fake /M Do Q cm) Tj /I Do', '/F Do /M Do Q /I Do'])
    page.node.addContentStream(doc.context.register(doc.context.flateStream(content)));
  const result = await index(doc);
  expect(result.images[0].map((i) => polygonBox(i.polygon))).toEqual([
    { x: 20, y: 30, width: 100, height: 50 },
    { x: 120, y: 130, width: 200, height: 150 },
    { x: 0, y: 0, width: 1, height: 1 },
  ]);
  expect(result.native).toEqual([false]);
  expect(result.images[0].every((i) => i.ref && !i.inline)).toBe(true);
});
it.each([0, 1, 6, 9])(
  'locates Flate inline data without inflating its image (compression %s)',
  async (level) => {
    const doc = await PDFDocument.create(),
      page = doc.addPage([400, 600]);
    const pixels = new Uint8Array(900);
    pixels.set(new TextEncoder().encode(' EI Q /Bogus Do '), 17);
    for (let i = 100; i < pixels.length; i++) pixels[i] = (i * 31) % 256;
    const encoded = deflateSync(pixels, { level }),
      head = new TextEncoder().encode(
        'q 40 0 0 30 10 20 cm BI /W 30 /H 10 /BPC 8 /CS /RGB /F /Fl ID ',
      ),
      tail = new TextEncoder().encode(' EI Q');
    const bytes = new Uint8Array(head.length + encoded.length + tail.length);
    bytes.set(head);
    bytes.set(encoded, head.length);
    bytes.set(tail, head.length + encoded.length);
    page.node.addContentStream(doc.context.register(doc.context.stream(bytes)));
    const result = await index(doc),
      image = result.images[0][0];
    expect(result.images[0]).toHaveLength(1);
    expect(image.inline!.end - image.inline!.start).toBe(encoded.length);
    expect(polygonBox(image.polygon)).toEqual({ x: 10, y: 20, width: 40, height: 30 });
  },
);
it('does not treat embedded EI bytes as an unfiltered image terminator', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 600]);
  const payload = ' EI Q /I Do ',
    head = 'BI /W 4 /H 1 /CS /RGB /BPC 8 ID ';
  page.node.addContentStream(doc.context.register(doc.context.stream(head + payload + ' EI')));
  const result = await index(doc);
  expect(result.images[0]).toHaveLength(1);
  expect(result.images[0][0].inline!.end - result.images[0][0].inline!.start).toBe(12);
});
it('places rotated annotation appearances independently of page content state and skips hidden appearances', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 600]);
  const image = doc.context.register(
    doc.context.stream(new Uint8Array([0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    }),
  );
  const ap = doc.context.register(
    doc.context.flateStream('/I Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 1, 1],
      Matrix: [0, 1, -1, 0, 1, 0],
      Resources: { XObject: { I: image } },
    }),
  );
  page.node.addContentStream(
    doc.context.register(doc.context.flateStream('100 0 0 100 900 800 cm')),
  );
  page.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      doc.context.register(
        doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 20, 50, 80], AP: { N: ap } }),
      ),
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Stamp',
          F: 2,
          Rect: [0, 0, 100, 100],
          AP: { N: ap },
        }),
      ),
    ]),
  );
  const result = await index(doc);
  expect(result.images[0]).toHaveLength(1);
  expect(result.images[0][0].polygon).toEqual([50, 20, 50, 80, 10, 80, 10, 20]);
});
