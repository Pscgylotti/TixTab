import { describe, it, expect } from 'vitest';
import { blankPage, type PlacedImage } from './model';
import { decodeObjects, encodeObjects, placeClipboardObjects } from './objectClipboard';
import { reorderObjects, objectBox } from './objectSelection';

const images: PlacedImage[] = [
  {
    id: 'a',
    kind: 'sketch',
    data: 'data:image/png;base64,AA==',
    scene: { elements: [{ id: 'line', type: 'line' }] },
    x: 10,
    y: 20,
    width: 40,
    height: 50,
  },
  {
    id: 'b',
    kind: 'formula',
    data: 'data:image/png;base64,AA==',
    latex: '\\RR',
    macros: { '\\RR': '\\mathbb{R}' },
    x: 70,
    y: 80,
    width: 80,
    height: 20,
  },
  {
    id: 'c',
    kind: 'text',
    data: 'data:image/png;base64,AA==',
    textBox: { content: '中文 & <text>', fontSize: 18, color: '#112233', bold: true },
    x: 200,
    y: 100,
    width: 60,
    height: 30,
  },
  {
    id: 'd',
    kind: 'image',
    data: 'data:image/png;base64,AA==',
    x: 10,
    y: 300,
    width: 40,
    height: 40,
  },
];
const page = { ...blankPage(600, 900), id: 'source', images };
describe('editable object clipboard and stacking order', () => {
  it('serializes in rendering order, retaining every editable field', () => {
    const payload = decodeObjects(encodeObjects(page, ['c', 'b', 'a', 'missing']))!;
    expect(payload.objects).toEqual(images.slice(0, 3));
    expect(payload.pageId).toBe(page.id);
  });
  it('rejects invalid, oversized-count, remote-data and malformed geometry payloads', () => {
    const payload = decodeObjects(encodeObjects(page, ['a']))!;
    for (const raw of [
      'null',
      '{',
      JSON.stringify({ ...payload, version: 2 }),
      JSON.stringify({ ...payload, objects: [] }),
      JSON.stringify({ ...payload, objects: Array(1001).fill(images[0]) }),
      JSON.stringify({
        ...payload,
        objects: [{ ...images[0], data: 'https://example.org/image.png' }],
      }),
      JSON.stringify({ ...payload, objects: [{ ...images[0], width: 0 }] }),
      JSON.stringify({ ...payload, objects: [{ ...images[0], x: 1e8 }] }),
      JSON.stringify({ ...payload, objects: [null] }),
    ])
      expect(decodeObjects(raw)).toBeNull();
  });
  it('gives independent pasted objects fresh IDs, preserving group offsets and metadata', () => {
    const payload = decodeObjects(encodeObjects(page, ['a', 'b', 'c']))!;
    const copies = placeClipboardObjects(payload, page);
    expect(new Set(copies.map((i) => i.id)).size).toBe(3);
    expect(copies.every((i) => !images.some((original) => original.id === i.id))).toBe(true);
    expect(copies.map((i) => [i.x, i.y, i.width, i.height])).toEqual(
      images.slice(0, 3).map((i) => [i.x + 16, i.y + 16, i.width, i.height]),
    );
    copies[0].scene!.elements = [];
    copies[1].macros!['\\RR'] = 'changed';
    copies[2].textBox!.content = 'changed';
    expect(payload.objects).toEqual(images.slice(0, 3));
  });
  it('fits a copied group uniformly to a smaller page and clamps edge anchors', () => {
    const payload = decodeObjects(encodeObjects(page, ['a', 'b', 'c']))!;
    const target = blankPage(100, 100),
      copies = placeClipboardObjects(payload, target, { x: 100, y: 100 });
    const bounds = objectBox(
      copies,
      copies.map((i) => i.id),
    )!;
    expect(bounds.x + bounds.width).toBeCloseTo(100);
    expect(bounds.y + bounds.height).toBeCloseTo(100);
    expect(copies[0].width / images[0].width).toBeCloseTo(copies[1].height / images[1].height);
    expect(bounds.width).toBeCloseTo(90);
  });
  it('front/back preserve selected and unselected relative order', () => {
    expect(reorderObjects(images, ['c', 'a'], 'front').map((i) => i.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
    expect(reorderObjects(images, ['c', 'a'], 'back').map((i) => i.id)).toEqual([
      'a',
      'c',
      'b',
      'd',
    ]);
    expect(images.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('one-layer steps move adjacent groups and separated selections stably', () => {
    expect(reorderObjects(images, ['a', 'b'], 'forward').map((i) => i.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
    expect(reorderObjects(images, ['c', 'd'], 'backward').map((i) => i.id)).toEqual([
      'a',
      'c',
      'd',
      'b',
    ]);
    expect(reorderObjects(images, ['a', 'c'], 'forward').map((i) => i.id)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
    expect(reorderObjects(images, ['b', 'd'], 'backward').map((i) => i.id)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
  });
  it('returns original references for boundary and empty-selection no-ops', () => {
    expect(reorderObjects(images, ['d'], 'front')).toBe(images);
    expect(reorderObjects(images, ['a'], 'backward')).toBe(images);
    expect(reorderObjects(images, [], 'forward')).toBe(images);
    expect(
      reorderObjects(
        images,
        images.map((i) => i.id),
        'back',
      ),
    ).toBe(images);
  });
});
