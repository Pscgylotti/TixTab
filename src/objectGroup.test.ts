import { expect, it } from 'vitest';
import { blankPage, validNotebook, type PlacedImage } from './model';
import {
  groupChildren,
  groupLeaves,
  groupDisplay,
  mergePageObjects,
  ungroupPageObject,
} from './objectGroup';
import { encodeObjects, decodeObjects } from './objectClipboard';
import { pageLayers } from './pageLayers';
import { packPdfExport } from './pdfExportSnapshot';
const child = (id: string, x: number): PlacedImage => ({
  id,
  kind: 'formula',
  latex: id,
  data: 'data:image/png;base64,AA==',
  x,
  y: 0,
  width: 20,
  height: 10,
});
const group: PlacedImage = {
  id: 'g',
  kind: 'image',
  data: 'data:image/png;base64,AA==',
  x: 100,
  y: 200,
  width: 120,
  height: 40,
  group: { width: 60, height: 20, objects: [child('a', 0), child('b', 40)] },
};
it('transforms editable children, preserves handwriting order and flattens original pixels for export', async () => {
  const children = groupChildren(group);
  expect(children.map((i) => [i.x, i.y, i.width, i.height])).toEqual([
    [100, 200, 40, 20],
    [180, 200, 40, 20],
  ]);
  const page = {
    ...blankPage(),
    images: [child('a', 0), child('other', 20), child('b', 40)],
    inkLayer: 1,
  };
  const merged = mergePageObjects(page, ['a', 'b'], group);
  expect(pageLayers(merged).map((i) => i?.id || 'ink')).toEqual(['ink', 'other', 'g']);
  const restored = ungroupPageObject(merged, group);
  expect(restored.ids).toHaveLength(2);
  expect(restored.page.images.map((i) => i.latex)).toEqual(['other', 'a', 'b']);
  const packed = await packPdfExport(
    { version: 1, name: 'group', source: null, pages: [merged] },
    new AbortController().signal,
  );
  expect(packed.notebook.pages[0].images.map((i) => i.x)).toEqual([20, 100, 180]);
  expect(packed.notebook.pages[0].images.every((i) => !i.group)).toBe(true);
});
it('accepts nested project groups but rejects excessive depth, cyclic and malformed metadata', () => {
  const notebook = (image: PlacedImage) => ({
    version: 1,
    name: 'group',
    source: null,
    pages: [{ ...blankPage(), images: [image] }],
  });
  expect(validNotebook(notebook(group))).toBe(true);
  expect(
    validNotebook(
      notebook({ ...group, group: { ...group.group!, objects: [group, child('a', 0)] } }),
    ),
  ).toBe(true);
  let deep = group;
  for (let i = 0; i < 8; i++)
    deep = { ...group, group: { ...group.group!, objects: [deep, child(`depth-${i}`, 0)] } };
  expect(validNotebook(notebook(deep))).toBe(false);
  const cyclic = { ...group, group: { ...group.group!, objects: [] as PlacedImage[] } };
  cyclic.group.objects = [cyclic, child('cycle', 0)];
  expect(validNotebook(notebook(cyclic))).toBe(false);
  const oversized = {
    ...group,
    group: {
      ...group.group!,
      objects: Array.from({ length: 501 }, (_, i) => ({ ...group, id: `g-${i}` })),
    },
  };
  expect(validNotebook(notebook(oversized))).toBe(false);
  expect(validNotebook(notebook({ ...group, group: { ...group.group!, width: 0 } }))).toBe(false);
});

it('ungroups one level at a time and flattens only display/export with composed transforms', async () => {
  const outer = {
    ...group,
    id: 'outer',
    x: 10,
    y: 20,
    width: 600,
    height: 400,
    group: { width: 300, height: 200, objects: [group, child('c', 0)] },
  };
  const page = { ...blankPage(), images: [outer], inkLayer: 0 };
  const first = ungroupPageObject(page, outer);
  expect(first.page.images).toHaveLength(2);
  expect(first.page.images[0].group).toEqual(group.group);
  expect(first.page.images[0]).toMatchObject({ x: 210, y: 420, width: 240, height: 80 });
  const second = ungroupPageObject(first.page, first.page.images[0]);
  expect(second.page.images.map((i) => i.latex)).toEqual(['a', 'b', 'c']);
  expect(groupLeaves(outer).map((i) => [i.x, i.y, i.width, i.height])).toEqual([
    [210, 420, 80, 40],
    [370, 420, 80, 40],
    [10, 20, 40, 20],
  ]);
  const payload = decodeObjects(encodeObjects(page, ['outer']))!;
  expect(payload.objects[0].group?.objects[0].group?.objects.map((i) => i.latex)).toEqual([
    'a',
    'b',
  ]);
  const packed = await packPdfExport(
    { version: 1, name: 'nested', source: null, pages: [page] },
    new AbortController().signal,
  );
  expect(packed.notebook.pages[0].images.map((i) => [i.x, i.y, i.width, i.height])).toEqual(
    groupLeaves(outer).map((i) => [i.x, i.y, i.width, i.height]),
  );
  expect(packed.notebook.pages[0].inkLayer).toBe(0);
  const display = atob(groupDisplay(outer).split(',')[1]);
  expect(display.match(/<image /g)).toHaveLength(3);
  expect(display.match(/<svg /g)).toHaveLength(1); // One flat display projection, three original leaves.
  const night = atob(groupDisplay(outer, true, true).split(',')[1]);
  expect(night.match(/invert\(0.9\)/g)).toHaveLength(3);
});
