import { describe, expect, it } from 'vitest';
import { objectBox, objectsInBox, transformObjects } from './objectSelection';
import type { PlacedImage } from './model';
const images: PlacedImage[] = [
  {
    id: 'a',
    kind: 'sketch',
    data: 'png',
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    scene: { preserved: true },
  },
  {
    id: 'b',
    kind: 'formula',
    data: 'png',
    x: 70,
    y: 80,
    width: 40,
    height: 20,
    latex: 'x',
    macros: { '\\RR': '\\mathbb{R}' },
  },
  { id: 'c', kind: 'sketch', data: 'png', x: 300, y: 300, width: 50, height: 50 },
];
describe('multiple object selection', () => {
  it('intersects object bounds, ignores zero-area clicks and returns a union box', () => {
    expect(objectsInBox(images, { x: 0, y: 0, width: 80, height: 90 })).toEqual(['a', 'b']);
    expect(objectsInBox(images, { x: 10, y: 20, width: 0, height: 40 })).toEqual([]);
    expect(objectBox(images, ['a', 'b'])).toEqual({ x: 10, y: 20, width: 100, height: 80 });
    expect(objectBox(images, ['missing'])).toBeNull();
  });
  it('scales the group uniformly while preserving metadata and untouched references', () => {
    const result = transformObjects(
      images,
      ['a', 'b'],
      { x: 10, y: 20, width: 100, height: 80 },
      { x: 50, y: 60, width: 200, height: 160 },
    );
    expect(result[0]).toMatchObject({
      x: 50,
      y: 60,
      width: 60,
      height: 80,
      scene: { preserved: true },
    });
    expect(result[1]).toMatchObject({
      x: 170,
      y: 180,
      width: 80,
      height: 40,
      latex: 'x',
      macros: images[1].macros,
    });
    expect(result[2]).toBe(images[2]);
    expect(images[0].x).toBe(10);
  });
});
