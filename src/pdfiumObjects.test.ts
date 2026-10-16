import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import {
  checkEditable,
  editPageObjects,
  listPageObjects,
  renderObjects,
  reorder,
  saveDocument,
  type PdfPageObject,
} from './pdfiumObjects';

const require = createRequire(import.meta.url);
let api: WrappedPdfiumModule;
beforeAll(async () => {
  api = await init({
    wasmBinary: readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')),
  });
  api.PDFiumExt_Init();
});

async function fixture() {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    page = doc.addPage([400, 300]);
  page.drawRectangle({ x: 20, y: 20, width: 360, height: 260, color: rgb(0.9, 0.95, 1) });
  page.drawText('Title text', { x: 40, y: 240, size: 18, font, color: rgb(0.1, 0.2, 0.6) });
  // Opaque, so rendered pixels are visible in the lifted-render test.
  const png = await doc.embedPng(
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer(),
  );
  page.drawImage(png, { x: 40, y: 80, width: 120, height: 90 });
  page.drawText('Body text', { x: 200, y: 120, size: 12, font });
  return doc.save();
}
function open(bytes: Uint8Array) {
  const m = api.pdfium as typeof api.pdfium & { HEAPU8: Uint8Array },
    p = m.wasmExports.malloc(bytes.length);
  m.HEAPU8.set(bytes, p);
  const document = api.FPDF_LoadMemDocument(p, bytes.length, '');
  if (!document) throw new Error('load failed');
  const page = api.FPDF_LoadPage(document, 0);
  return {
    document,
    page,
    close: () => {
      api.FPDF_ClosePage(page);
      api.FPDF_CloseDocument(document);
      m.wasmExports.free(p);
    },
  };
}
/** Edit, save and reopen: what another reader would see. */
function roundTrip(bytes: Uint8Array, edit: (page: number, objects: PdfPageObject[]) => void) {
  const before = open(bytes);
  try {
    edit(before.page, listPageObjects(api, before.page));
    const saved = saveDocument(api, before.document),
      after = open(saved);
    try {
      return { saved, objects: listPageObjects(api, after.page) };
    } finally {
      after.close();
    }
  } finally {
    before.close();
  }
}
const kinds = (objects: PdfPageObject[]) =>
  objects.map((o) => o.kind + (o.text ? ':' + o.text : ''));

describe('PDFium page objects', () => {
  it('lists objects in drawing order with text, fonts and colours', async () => {
    const bytes = await fixture(),
      { page, close } = open(bytes);
    try {
      const objects = listPageObjects(api, page);
      expect(kinds(objects)).toEqual(['path', 'text:Title text', 'image', 'text:Body text']);
      const title = objects[1];
      expect(title.font).toBe('Helvetica');
      expect(title.fontSize).toBeCloseTo(18, 3);
      expect(title.fill).toBe('#1a3399');
      expect(objects[0].fill).toBe('#e6f2ff');
      const image = objects[2];
      expect(image.bounds.map(Math.round)).toEqual([40, 80, 160, 170]);
    } finally {
      close();
    }
  });

  it('moves one object and leaves the rest and their order untouched', async () => {
    const bytes = await fixture(),
      { objects } = roundTrip(bytes, (page, list) =>
        editPageObjects(api, page, [
          { index: 2, key: list[2].key, transform: [1, 0, 0, 1, 150, 30] },
        ]),
      ),
      original = open(bytes),
      before = listPageObjects(api, original.page);
    original.close();
    expect(kinds(objects)).toEqual(kinds(before));
    expect(objects[2].bounds.map(Math.round)).toEqual([190, 110, 310, 200]);
    for (const i of [0, 1, 3]) expect(objects[i].bounds).toEqual(before[i].bounds);
  });

  it('rotates text about its centre and keeps it as real, extractable text', async () => {
    const bytes = await fixture(),
      { objects } = roundTrip(bytes, (page, list) => {
        const [l, b, r, t] = list[1].bounds,
          cx = (l + r) / 2,
          cy = (b + t) / 2;
        // Rotate 90° counter-clockwise around the centre.
        editPageObjects(api, page, [
          { index: 1, key: list[1].key, transform: [0, 1, -1, 0, cx + cy, cy - cx] },
        ]);
      });
    const title = objects[1];
    expect(title.kind).toBe('text');
    expect(title.text).toBe('Title text');
    // Font size lives in the text state; the object matrix is the pure rotation.
    expect(title.matrix.slice(0, 4).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 1, -1, 0]);
    const [l, b, r, t] = title.bounds;
    expect(t - b).toBeGreaterThan(r - l);
  });

  it('deletes, restyles and restacks in one transaction', async () => {
    const bytes = await fixture(),
      { objects } = roundTrip(bytes, (page, list) =>
        editPageObjects(api, page, [
          { index: 3, key: list[3].key, delete: true },
          { index: 0, key: list[0].key, fill: '#ff8800', stroke: '#000000', strokeWidth: 3 },
          { index: 0, key: list[0].key, order: 'front' },
        ]),
      );
    expect(kinds(objects)).toEqual(['text:Title text', 'image', 'path']);
    expect(objects[2].fill).toBe('#ff8800');
    expect(objects[2].stroke).toBe('#000000');
    expect(objects[2].strokeWidth).toBeCloseTo(3, 3);
  });

  it('rejects a stale object without changing anything', async () => {
    const bytes = await fixture(),
      { page, document, close } = open(bytes);
    try {
      const list = listPageObjects(api, page);
      expect(() =>
        editPageObjects(api, page, [
          { index: 3, key: list[3].key, delete: true },
          { index: 2, key: 'image|0|0|0|0||', transform: [1, 0, 0, 1, 5, 5] },
        ]),
      ).toThrow('element-stale');
      expect(kinds(listPageObjects(api, page))).toEqual(kinds(list));
      expect(saveDocument(api, document).length).toBeGreaterThan(100);
    } finally {
      close();
    }
  });

  it('allows editing an ordinary unsigned, unencrypted document', async () => {
    const { document, close } = open(await fixture());
    try {
      expect(() => checkEditable(api, document)).not.toThrow();
    } finally {
      close();
    }
  });

  it('refuses a transform that would collapse an object', async () => {
    const bytes = await fixture(),
      { page, close } = open(bytes);
    try {
      const list = listPageObjects(api, page);
      expect(() =>
        editPageObjects(api, page, [{ index: 2, key: list[2].key, transform: [0, 0, 0, 0, 1, 1] }]),
      ).toThrow('invalid-transform');
    } finally {
      close();
    }
  });
});

describe('lifted rendering for drag previews', () => {
  it('renders only the chosen objects, or the page without them, and restores both', async () => {
    const bytes = await fixture(),
      { page, document, close } = open(bytes);
    try {
      // Page is 400×300 and unrotated; one device pixel per page unit.
      const matrix = [1, 0, 0, 1, 0, 0],
        pixel = (data: Uint8ClampedArray, x: number, y: number) =>
          Array.from(data.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 4));
      const only = renderObjects(api, page, [2], matrix, 400, 300, 'only'),
        except = renderObjects(api, page, [2], matrix, 400, 300, 'except');
      // Inside the image (40..160, 130..220 top-down) vs. on the background rectangle.
      expect(pixel(only, 100, 175)[3]).toBe(255);
      expect(pixel(only, 300, 60)[3]).toBe(0);
      expect(pixel(except, 100, 175)).toEqual([230, 242, 255, 255]);
      // Nothing stays hidden: a normal save still contains all four objects.
      const reopened = open(saveDocument(api, document));
      expect(listPageObjects(api, reopened.page)).toHaveLength(4);
      reopened.close();
    } finally {
      close();
    }
  });
});

describe('stacking order', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  it.each([
    ['front', ['b', 'd'], ['a', 'c', 'e', 'b', 'd']],
    ['back', ['b', 'd'], ['b', 'd', 'a', 'c', 'e']],
    ['forward', ['b', 'd'], ['a', 'c', 'b', 'e', 'd']],
    ['backward', ['b', 'd'], ['b', 'a', 'd', 'c', 'e']],
    ['forward', ['d', 'e'], ['a', 'b', 'c', 'd', 'e']],
    ['backward', ['a', 'b'], ['a', 'b', 'c', 'd', 'e']],
  ] as const)('%s %j', (order, chosen, expected) => {
    expect(reorder(items, new Set(chosen), order)).toEqual(expected);
  });
});
