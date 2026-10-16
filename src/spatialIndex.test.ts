import { describe, expect, it } from 'vitest';
import { SpatialIndex, imageBounds, overlaps, sweptBounds } from './spatialIndex';
import { inkBounds, finalInkPath, rememberInkPath } from './ink';
import { hitStroke, hitImage, type PlacedImage, type Stroke } from './model';
import { objectsInBox } from './objectSelection';

let seed = 813;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const stroke = (id: number): Stroke => ({
  id: `s${id}`,
  tool: ['pen', 'ballpoint', 'pencil', 'highlighter'][id % 4] as Stroke['tool'],
  color: '#0088ff',
  size: 1 + random() * 35,
  points: Array.from({ length: (id % 15) + 1 }, () => [random() * 595, random() * 842, random()]),
});
const image = (id: number): PlacedImage => ({
  id: `i${id}`,
  kind: 'image',
  data: '',
  x: random() * 595,
  y: random() * 842,
  width: random() * 60,
  height: random() * 60,
});

describe('dynamic bounding hierarchy', () => {
  it('matches ordered brute force through append, deletion, edits, reorder, undo and duplicate references', () => {
    let items = Array.from({ length: 500 }, (_, i) => image(i));
    const index = new SpatialIndex<PlacedImage>(imageBounds);
    const original = items;
    for (let step = 0; step < 140; step++) {
      if (step % 7 === 0) items = [...items, image(step + 1000)];
      if (step % 7 === 1) items = items.filter((_, i) => i % 17);
      if (step % 7 === 2) items = items.map((v, i) => (i % 19 ? v : { ...v, x: v.x + 17 }));
      if (step % 7 === 3) items = [...items].reverse();
      if (step % 7 === 4) items = [...items, items[0], items[0]];
      if (step % 7 === 5) items = items.slice(0, 20); // cross the small-scene threshold
      if (step % 7 === 6) items = original;
      index.update(items);
      for (let q = 0; q < 10; q++) {
        const box = imageBounds({ x: random() * 595, y: random() * 842, width: 100, height: 120 });
        expect(index.search(box)).toEqual(items.filter((v) => overlaps(imageBounds(v), box)));
      }
    }
  });

  it('inserts a new stroke without rebuilding or recomputing existing bounds', () => {
    const items = Array.from({ length: 3000 }, (_, i) => ({
      x: i * 10,
      y: 0,
      width: 2,
      height: 2,
    }));
    const index = new SpatialIndex(imageBounds);
    index.update(items);
    expect(index.stats).toMatchObject({ builds: 1, bounds: 3000 });
    const next = [...items, { x: 40, y: 20, width: 2, height: 2 }];
    index.update(next);
    index.update(next);
    expect(index.stats).toMatchObject({ builds: 1, inserts: 1, bounds: 3001 });
    const changes = index.update(next.filter((_, i) => i !== 5));
    expect(changes.reordered).toBe(false);
    expect(index.stats).toMatchObject({ builds: 1, removes: 1, bounds: 3001 });
    expect(index.search({ minX: 29980, minY: 0, maxX: 29982, maxY: 2 })).toHaveLength(1);
  });

  it('reports actual survivor reordering, but not shifted indices after deletion/insertion', () => {
    const items = Array.from({ length: 5 }, (_, i) => image(i)),
      index = new SpatialIndex<PlacedImage>(imageBounds);
    index.update(items);
    expect(index.update(items.slice(1)).reordered).toBe(false);
    expect(index.update(items).reordered).toBe(false);
    expect(index.update([...items].reverse()).reordered).toBe(true);
  });

  it('conservatively covers exact pressure outlines and seeded export paths', () => {
    for (let i = 0; i < 160; i++) {
      const s = stroke(i),
        box = inkBounds(s);
      for (const match of finalInkPath(s).matchAll(/(-?[\d.]+),(-?[\d.]+)/g)) {
        const x = Number(match[1]),
          y = Number(match[2]);
        expect(x).toBeGreaterThanOrEqual(box.minX);
        expect(x).toBeLessThanOrEqual(box.maxX);
        expect(y).toBeGreaterThanOrEqual(box.minY);
        expect(y).toBeLessThanOrEqual(box.maxY);
      }
      expect(inkBounds(s)).toBe(box);
    }
    const s = { ...stroke(0), points: [] };
    rememberInkPath(s, 'M -10.25,20 L 30,40 Z');
    expect(inkBounds(s)).toEqual({ minX: -10.25, minY: 20, maxX: 30, maxY: 40 });
  }, 15000);

  it('never drops an exact swept eraser hit, including fast crossing and pressure strokes', () => {
    const strokes = Array.from({ length: 350 }, (_, i) => stroke(i)),
      images = Array.from({ length: 350 }, (_, i) => image(i));
    const ink = new SpatialIndex(inkBounds),
      objects = new SpatialIndex<PlacedImage>(imageBounds);
    ink.update(strokes);
    objects.update(images);
    for (let i = 0; i < 120; i++) {
      const from = [random() * 650 - 20, random() * 900 - 20, 0.5] as [number, number, number],
        to = [random() * 650 - 20, random() * 900 - 20, 0.5] as [number, number, number],
        radius = random() * 25,
        box = sweptBounds(from, to, radius);
      expect(ink.search(box).filter((s) => hitStroke(s, from, to, radius))).toEqual(
        strokes.filter((s) => hitStroke(s, from, to, radius)),
      );
      expect(objects.search(box).filter((s) => hitImage(s, from, to, radius))).toEqual(
        images.filter((s) => hitImage(s, from, to, radius)),
      );
    }
  });

  it('preserves strict marquee edges, zero area and scene layer order', () => {
    const images = Array.from({ length: 120 }, (_, i) => ({
        ...image(i),
        x: i * 10,
        y: 0,
        width: 10,
        height: 10,
      })),
      index = new SpatialIndex<PlacedImage>(imageBounds);
    for (const box of [
      { x: 10, y: 0, width: 10, height: 10 },
      { x: 2, y: 2, width: 0, height: 10 },
      { x: 10, y: 10, width: 10, height: 10 },
    ])
      expect(objectsInBox(images, box, index)).toEqual(objectsInBox(images, box));
  });
});
