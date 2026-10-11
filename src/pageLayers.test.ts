import { expect, test } from 'vitest';
import { blankPage, validNotebook, type Notebook, type PlacedImage } from './model';
import {
  inkLayerIndex,
  pageLayers,
  reorderPageLayers,
  removePageImages,
  appendPageImages,
} from './pageLayers';
import { encodeProject, decodeProject } from './storage';
import { packPdfExport, unpackPdfExport } from './pdfExportSnapshot';
const images: PlacedImage[] = Array.from({ length: 3 }, (_, i) => ({
  id: String(i),
  kind: 'image',
  data: 'data:image/png;base64,AA==',
  x: 10,
  y: 10,
  width: 20,
  height: 20,
}));
const page = {
  ...blankPage(),
  images,
  strokes: [
    {
      id: 's',
      tool: 'pen' as const,
      color: '#ff0000',
      size: 10,
      points: [
        [10, 10, 0.5],
        [30, 30, 0.9],
      ] as [number, number, number][],
    },
  ],
};
const notebook = (inkLayer?: number): Notebook => ({
  version: 1,
  name: 'Layers',
  source: null,
  pages: [{ ...page, inkLayer }],
});
test('legacy handwriting is one group above all objects', () => {
  expect(inkLayerIndex(page)).toBe(3);
  expect(pageLayers(page).map((i) => i?.id ?? 'ink')).toEqual(['0', '1', '2', 'ink']);
});
test('objects can cross the handwriting group without changing their own relative order', () => {
  const result = reorderPageLayers(page, ['1', '2'], 'front');
  expect(pageLayers(result).map((i) => i?.id ?? 'ink')).toEqual(['0', 'ink', '1', '2']);
  expect(result.strokes).toBe(page.strokes);
  expect(
    pageLayers(reorderPageLayers(result, ['1', '2'], 'back')).map((i) => i?.id ?? 'ink'),
  ).toEqual(['1', '2', '0', 'ink']);
});
test('handwriting alone moves by one layer or to either end, with no-op reference stability', () => {
  const middle = reorderPageLayers(page, [], 'backward', true);
  expect(middle.inkLayer).toBe(2);
  expect(middle.images).toEqual(images);
  expect(reorderPageLayers(middle, [], 'back', true).inkLayer).toBe(0);
  expect(reorderPageLayers(page, [], 'front', true)).toBe(page);
});
test('deleting below/above ink preserves the logical position and valid project bounds', () => {
  const middle = { ...page, inkLayer: 1 };
  expect(removePageImages(middle, ['0']).inkLayer).toBe(0);
  expect(removePageImages(middle, ['2']).inkLayer).toBe(1);
  const empty = removePageImages(middle, ['0', '1', '2']);
  expect(empty.inkLayer).toBe(0);
  expect(validNotebook({ ...notebook(), pages: [empty] })).toBe(true);
});
test('appending objects preserves chosen ink order and legacy top defaults', () => {
  expect(appendPageImages({ ...page, inkLayer: 1 }, [images[0]]).inkLayer).toBe(1);
  expect(appendPageImages(page, [images[0]]).inkLayer).toBeUndefined();
  expect(inkLayerIndex(appendPageImages(page, [images[0]]))).toBe(4);
});
test('project round-trip stores ordering and rejects invalid layer positions', () => {
  expect(decodeProject(encodeProject(notebook(1))).pages[0].inkLayer).toBe(1);
  for (const n of [-1, 0.5, 4, Infinity]) expect(validNotebook(notebook(n))).toBe(false);
});
test('worker snapshot and transferred unpack retain ink ordering and exact points', async () => {
  const packed = await packPdfExport(notebook(1), new AbortController().signal);
  const restored = unpackPdfExport(
    structuredClone(packed.notebook, { transfer: packed.transfers }),
  );
  expect(restored.pages[0].inkLayer).toBe(1);
  expect(pageLayers(restored.pages[0]).map((i) => i?.id ?? 'ink')).toEqual(['0', 'ink', '1', '2']);
  expect(restored.pages[0].strokes[0].points).toEqual(page.strokes[0].points);
});
