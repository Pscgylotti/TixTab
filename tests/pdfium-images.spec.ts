import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const {
  PDFDocument,
  StandardFonts,
  degrees,
  PDFName,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
} = createRequire(import.meta.url)('pdf-lib');
const sharp = createRequire(import.meta.url)('sharp');

async function fixture(kind = 'ordinary') {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const pixels = Buffer.alloc(64 * 48 * 4);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++) {
      const at = (y * 64 + x) * 4;
      pixels[at] = x < 32 ? 230 : 20;
      pixels[at + 1] = y < 24 ? 190 : 30;
      pixels[at + 2] = x >= 32 ? 220 : 10;
      pixels[at + 3] = x < 8 && y < 8 ? 0 : 255;
    }
  const image = await doc.embedPng(
    await sharp(pixels, { raw: { width: 64, height: 48, channels: 4 } })
      .png()
      .toBuffer(),
  );
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([400, 600]);
    if (kind === 'softmask') {
      const mask = doc.context.register(
        doc.context.flateStream('0.5 g 0 0 400 600 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 600],
          Group: { S: 'Transparency', CS: 'DeviceGray' },
        }),
      );
      const state = p.node.newExtGState(
        'PageMask',
        doc.context.register(
          doc.context.obj({ Type: 'ExtGState', SMask: { S: 'Luminosity', G: mask } }),
        ),
      );
      p.node.addContentStream(
        doc.context.register(doc.context.flateStream(`q ${state.toString()} gs`)),
      );
    }

    p.drawImage(image, {
      x: 30,
      y: 100,
      width: 80,
      height: 60,
      ...(kind === 'opacity' ? { opacity: 0.4 } : {}),
    });
    p.drawImage(image, { x: 200, y: 200, width: 90, height: 70, rotate: degrees(20) });
    if (kind !== 'scan') {
      const inner = doc.context.register(
        doc.context.flateStream('/I Do', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 1, 1],
          Matrix: [1, 0.2, 0, 1, 0, 0],
          Resources: { XObject: { I: image.ref } },
        }),
      );
      const outer = doc.context.register(
        doc.context.flateStream('/Inner Do', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 2, 2],
          Matrix: [0.8, 0, 0.1, 0.7, 0.2, 0.1],
          Resources: { XObject: { Inner: inner } },
        }),
      );
      const key = p.node.newXObject('Nested', outer);
      p.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(60, 0, 0, 50, 120, 370),
        drawObject(key),
        popGraphicsState(),
      );
    }
    p.drawText('Text overlay is not part of the source image', { x: 30, y: 120, font, size: 10 });
    if (kind === 'stencil') {
      const mask = doc.context.register(
        doc.context.stream(new Uint8Array([0xf0, 0x0f]), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 8,
          Height: 2,
          BitsPerComponent: 1,
          ImageMask: true,
        }),
      );
      const name = p.node.newXObject('Mask', mask);
      p.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(40, 0, 0, 20, 10, 10),
        drawObject(name),
        popGraphicsState(),
      );
    }
    if (kind === 'inline')
      p.node.addContentStream(
        doc.context.register(
          doc.context.stream(
            'q 10 0 0 10 10 10 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI Q',
          ),
        ),
      );
    if (kind === 'appearance') {
      const ap = doc.context.register(
        doc.context.flateStream('/I Do', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 1, 1],
          Resources: { XObject: { I: image.ref } },
        }),
      );
      p.node.set(
        PDFName.of('Annots'),
        doc.context.obj([
          doc.context.register(
            doc.context.obj({
              Type: 'Annot',
              Subtype: 'Stamp',
              Rect: [10, 20, 50, 60],
              AP: { N: ap },
            }),
          ),
        ]),
      );
    }
  }
  return Array.from(await doc.save());
}

test('native image ordering/transforms match source geometry; source pixels, alpha and decoder lifetime stay bounded', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(
    async (bytes) => {
      const { loadPdfiumDocument } = await import('/src/pdfiumDocument.ts');
      const { getPdfImages } = await import('/src/pdfNight.ts');
      const { drawPdfOriginalImage } = await import('/src/pdfOriginalImage.ts');
      const { bitmapPdfDecoder } = await import('/src/bitmapPdfDecoder.ts');
      const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
      const native = await loadPdfiumDocument(new Uint8Array(bytes));
      try {
        const expected = [],
          actual = [];
        for (let i = 0; i < 3; i++) {
          const angle = (20 * Math.PI) / 180,
            c = Math.cos(angle),
            s = Math.sin(angle);
          expected.push([
            [30, 100, 110, 100, 110, 160, 30, 160],
            [
              200,
              200,
              200 + 90 * c,
              200 + 90 * s,
              200 + 90 * c - 70 * s,
              200 + 90 * s + 70 * c,
              200 - 70 * s,
              200 + 70 * c,
            ],
            [132, 375, 181.2, 382, 187.2, 417, 138, 410],
          ]);
          actual.push(await getPdfImages(native, i));
        }
        const a = document.createElement('canvas'),
          b = document.createElement('canvas'),
          signal = new AbortController().signal;
        const referencePixels = [],
          nativePixels = [],
          decodedImages = [];
        for (let i = 0; i < 3; i++) {
          a.width = 64;
          a.height = 48;
          const ctx = a.getContext('2d')!,
            pixels = ctx.createImageData(64, 48);
          for (let y = 0; y < 48; y++)
            for (let x = 0; x < 64; x++) {
              const at = (y * 64 + x) * 4;
              pixels.data.set(
                [
                  x < 32 ? 230 : 20,
                  y < 24 ? 190 : 30,
                  x >= 32 ? 220 : 10,
                  x < 8 && y < 8 ? 0 : 255,
                ],
                at,
              );
            }
          ctx.putImageData(pixels, 0, 0);
          if (!(await drawPdfOriginalImage(native, 0, i, b, signal)))
            throw Error('Native original unavailable');
          referencePixels.push({
            size: [a.width, a.height],
            data: Array.from(a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data),
          });
          nativePixels.push({
            size: [b.width, b.height],
            data: Array.from(b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data),
          });
          decodedImages.push(i);
        }
        const decoder = bitmapPdfDecoder(native, signal, 768),
          sizes = [];
        try {
          for (let i = 0; i < 3; i++) {
            await decoder.draw(i, 0, b);
            sizes.push(b.width * b.height);
          }
        } finally {
          await decoder.close();
          a.width = a.height = b.width = b.height = 1;
        }
        const after = getPdfiumStats();
        return {
          expected,
          actual,
          referencePixels,
          nativePixels,
          decodedImages,
          sizes,
          after,
        };
      } finally {
        await native.destroy();
      }
    },
    await fixture(),
  );
  for (let i = 0; i < 3; i++) {
    expect(result.actual[i]).toHaveLength(3);
    result.actual[i].forEach((quad, j) =>
      quad.forEach((n, k) => expect(n).toBeCloseTo(result.expected[i][j][k], 3)),
    );
    expect(result.nativePixels[i].size).toEqual(result.referencePixels[i].size);
    const a = result.nativePixels[i].data,
      b = result.referencePixels[i].data;
    let alphaError = 0,
      colorError = 0;
    for (let n = 0; n < a.length; n += 4) {
      alphaError = Math.max(alphaError, Math.abs(a[n + 3] - b[n + 3]));
      if (b[n + 3] > 250)
        for (let c = 0; c < 3; c++)
          colorError = Math.max(colorError, Math.abs(a[n + c] - b[n + c]));
    }
    expect(alphaError).toBeLessThanOrEqual(2);
    expect(colorError).toBeLessThanOrEqual(2);
  }
  expect(result.decodedImages).toEqual([0, 1, 2]);
  expect(result.sizes.every((size) => size <= 768)).toBe(true);
  expect(result.after.decoderWorkers).toBe(0);
});

for (const kind of ['stencil', 'inline', 'appearance', 'opacity', 'softmask'])
  test(`${kind}: preserves legacy image IDs and pixels without a second engine`, async ({
    page,
  }) => {
    await page.goto('/');
    const result = await page.evaluate(
      async ({ bytes, kind }) => {
        const { loadPdfiumDocument } = await import('/src/pdfiumDocument.ts');
        const { getPdfImages } = await import('/src/pdfNight.ts');
        const { bitmapPdfDecoder } = await import('/src/bitmapPdfDecoder.ts');
        const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
        const b = await loadPdfiumDocument(new Uint8Array(bytes));
        const canvas = document.createElement('canvas'),
          decoder = bitmapPdfDecoder(b, new AbortController().signal);
        try {
          const actual = await getPdfImages(b, 0);
          const angle = (20 * Math.PI) / 180,
            c = Math.cos(angle),
            s = Math.sin(angle);
          const expected = [
            [30, 100, 110, 100, 110, 160, 30, 160],
            [
              200,
              200,
              200 + 90 * c,
              200 + 90 * s,
              200 + 90 * c - 70 * s,
              200 + 90 * s + 70 * c,
              200 - 70 * s,
              200 + 70 * c,
            ],
            [132, 375, 181.2, 382, 187.2, 417, 138, 410],
          ];
          if (kind === 'inline') expected.push([10, 10, 20, 10, 20, 20, 10, 20]);
          if (kind === 'appearance') expected.push([10, 20, 50, 20, 50, 60, 10, 60]);
          const decoded = await decoder.draw(0, 0, canvas);
          const decodedSizes = [];
          for (let i = 0; i < actual.length; i++) {
            if (!(await decoder.draw(0, i, canvas))) throw Error('image missing');
            decodedSizes.push([canvas.width, canvas.height]);
          }
          await decoder.draw(0, 0, canvas);
          await decoder.close();
          return {
            decodedSizes,
            expected,
            actual,
            decoded,
            size: [canvas.width, canvas.height],
            alpha: canvas.getContext('2d')!.getImageData(20, 20, 1, 1).data[3],
            after: getPdfiumStats(),
          };
        } finally {
          await decoder.close();
          await b.destroy();
          canvas.width = canvas.height = 1;
        }
      },
      { bytes: await fixture(kind), kind },
    );
    expect(result.actual).toHaveLength(result.expected.length);
    result.actual.forEach((quad, i) =>
      quad.forEach((n, j) => expect(n).toBeCloseTo(result.expected[i][j], 3)),
    );
    expect(result.decoded).toBe(true);
    expect(
      result.decodedSizes.every(
        (v, i) =>
          v[0] === (kind === 'inline' && i === 3 ? 1 : 64) &&
          v[1] === (kind === 'inline' && i === 3 ? 1 : 48),
      ),
    ).toBe(true);
    expect(result.size).toEqual([64, 48]);
    expect(result.alpha).toBe(255);
    expect(result.after.decoderWorkers).toBe(0);
  });

test('ordinary bitmap batches never open PDF.js and release every decoder worker after completion or stop', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(
    async (bytes) => {
      const { loadPdfiumDocument } = await import('/src/pdfiumDocument.ts');
      const { bitmapPdfDecoder } = await import('/src/bitmapPdfDecoder.ts');
      const { getPdfImages } = await import('/src/pdfNight.ts');
      const { getPdfiumStats } = await import('/src/pdfiumRaster.ts');
      const NativeWorker = window.Worker;
      let created = 0,
        terminated = 0,
        nonNativeCreated = 0;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          created++;
          if (!String(url).includes('pdfium.worker')) nonNativeCreated++;
        }
        terminate() {
          terminated++;
          super.terminate();
        }
      };
      const pdf = await loadPdfiumDocument(new Uint8Array(bytes)),
        sizes = [],
        workers = [];
      try {
        for (let i = 0; i < 3; i++)
          if ((await getPdfImages(pdf, i)).length !== 2) throw Error('bitmap inventory changed');
        for (let cycle = 0; cycle < 3; cycle++) {
          const decoder = bitmapPdfDecoder(pdf, new AbortController().signal, 768);
          const canvases = Array.from({ length: 6 }, () => document.createElement('canvas'));
          try {
            await Promise.all(
              canvases.map(async (c, i) => {
                if (!(await decoder.draw(Math.floor(i / 2), i % 2, c)))
                  throw Error('source image missing');
                sizes.push(c.width * c.height);
              }),
            );
          } finally {
            await decoder.close();
            canvases.forEach((c) => (c.width = c.height = 1));
          }
          workers.push(getPdfiumStats().decoderWorkers);
        }
        const abort = new AbortController(),
          stopped = bitmapPdfDecoder(
            { tixtabBackend: 'pdfium', getData: () => new Promise(() => {}) } as any,
            abort.signal,
          );
        const pending = stopped.draw(0, 0, document.createElement('canvas')).then(
          () => 'completed',
          (e) => e.name,
        );
        for (let i = 0; i < 100 && !getPdfiumStats().decoderWorkers; i++)
          await new Promise((r) => setTimeout(r, 10));
        abort.abort();
        const cancelled = await pending;
        await stopped.close();
        await pdf.destroy();
        for (let i = 0; i < 100 && getPdfiumStats().documents; i++)
          await new Promise((r) => setTimeout(r, 10));
        return {
          created,
          terminated,
          nonNativeCreated,
          workers,
          sizes,
          cancelled,
          stats: getPdfiumStats(),
        };
      } finally {
        await pdf.destroy();
        window.Worker = NativeWorker;
      }
    },
    await fixture('scan'),
  );
  expect(result.nonNativeCreated).toBe(0);
  expect(result.created - result.terminated).toBe(1);
  expect(result.workers).toEqual([0, 0, 0]);
  expect(result.sizes).toHaveLength(18);
  expect(result.sizes.every((size) => size <= 768)).toBe(true);
  expect(result.cancelled).toBe('AbortError');
  expect(result.stats).toMatchObject({
    workers: 1,
    decoderWorkers: 0,
    documents: 0,
    sessions: 0,
    pending: 0,
    initializations: 1,
  });
});
