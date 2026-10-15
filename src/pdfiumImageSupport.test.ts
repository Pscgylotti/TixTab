import { expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { nativeImageSupport } from './pdfiumImageSupport';

it('does not inspect image pixels and keeps ordinary and soft-mask image streams eligible', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const mask = doc.context.register(
    doc.context.stream(new Uint8Array([0, 128]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 1,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    }),
  );
  doc.context.register(
    doc.context.stream(new Uint8Array([255, 0, 0, 0, 255, 0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 1,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      SMask: mask,
    }),
  );
  expect(await nativeImageSupport(doc, () => {})).toEqual([true]);
});

it.each(['stencil', 'inline', 'form-inline', 'oversized', 'unsupported-filter'])(
  'conservatively routes %s structures without rasterizing them',
  async (kind) => {
    const doc = await PDFDocument.create(),
      p = doc.addPage();
    if (kind === 'stencil')
      doc.context.register(
        doc.context.stream(new Uint8Array([128]), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 1,
          Height: 1,
          ImageMask: true,
        }),
      );
    else if (kind === 'form-inline')
      doc.context.register(doc.context.flateStream('BI/W 1 /H 1 ID x EI', { Subtype: 'Form' }));
    else
      p.node.addContentStream(
        doc.context.register(
          doc.context.stream(
            kind === 'oversized' ? new Uint8Array(1_000_001) : 'q BI/W 1 /H 1 ID x EI Q',
            kind === 'unsupported-filter' ? { Filter: 'LZWDecode' } : {},
          ),
        ),
      );
    expect(await nativeImageSupport(doc, () => {})).toEqual([false]);
  },
);

it('limits annotation appearance compatibility to affected pages and stops promptly on cancellation', async () => {
  const doc = await PDFDocument.create(),
    p = doc.addPage();
  doc.addPage();
  p.node.set(
    PDFName.of('Annots'),
    doc.context.obj([doc.context.register(doc.context.obj({ Subtype: 'Stamp', AP: {} }))]),
  );
  expect(await nativeImageSupport(doc, () => {})).toEqual([false, true]);
  await expect(
    nativeImageSupport(doc, () => {
      throw new Error('cancelled');
    }),
  ).rejects.toThrow('cancelled');
});

it('bounds compressed content preflight instead of expanding an entire oversized stream', async () => {
  const doc = await PDFDocument.create(),
    p = doc.addPage();
  p.node.addContentStream(doc.context.register(doc.context.flateStream('q '.repeat(2_000_000))));
  expect(await nativeImageSupport(doc, () => {})).toEqual([false]);
});

it('keeps page graphics-state opacity out of source image extraction', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  // Direct dictionaries under Resources are not separate indirect objects.
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ ExtGState: { GS: { Type: 'ExtGState', ca: 0.4 } } }),
  );
  expect(await nativeImageSupport(doc, () => {})).toEqual([false]);
});
