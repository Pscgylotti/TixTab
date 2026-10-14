import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, degrees, PDFNumber } from 'pdf-lib';
import { blankPage, newNotebook, validNotebook, type Page } from './model';
import { operatePages, transformPage, scopePages } from './pageOperations';
import { exportPdf, exportPageGeometry } from './pdfExport';
import { packPdfExport, unpackPdfExport } from './pdfExportSnapshot';
import { clonePage } from './duplicatePage';
import { imageCorners } from './objectRotation';
import { historyTarget } from './historyNavigation';

function annotated(): Page {
  return {
    ...blankPage(400, 600),
    strokes: [
      {
        id: 'ink',
        tool: 'pen',
        color: '#123456',
        size: 2,
        points: [
          [40, 60, 0.4],
          [50, 70, 0.8],
        ],
      },
    ],
    images: [
      {
        id: 'picture',
        kind: 'image',
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        x: 40,
        y: 160,
        width: 160,
        height: 80,
      },
    ],
    reviews: [
      { id: 'review', text: '批注 review', region: { x: 30, y: 40, width: 100, height: 30 } },
    ],
  };
}
describe('page editing preserves native geometry and foreground', () => {
  it('rotates ink, pictures, group hierarchy and review anchors reversibly', () => {
    const page = annotated();
    page.images.push({
      id: 'group',
      kind: 'image',
      data: page.images[0].data,
      x: 250,
      y: 300,
      width: 100,
      height: 120,
      group: {
        width: 100,
        height: 120,
        objects: [
          { ...page.images[0], id: 'child1', x: 10, y: 10, width: 30, height: 20 },
          { ...page.images[0], id: 'child2', x: 50, y: 40, width: 40, height: 60 },
        ],
      },
    });
    const rotated = transformPage(page, { action: 'rotate', angle: 90 });
    expect([rotated.width, rotated.height]).toEqual([600, 400]);
    expect(rotated.strokes[0].points[0]).toEqual([540, 40, 0.4]);
    expect(rotated.images[0]).toMatchObject({
      x: 360,
      y: 40,
      width: 80,
      height: 160,
      rotation: 90,
    });
    expect(imageCorners(rotated.images[0])).toEqual([440, 40, 440, 200, 360, 200, 360, 40]);
    expect(rotated.reviews![0].region).toEqual({ x: 530, y: 30, width: 30, height: 100 });
    const restored = transformPage(rotated, { action: 'rotate', angle: 270 });
    expect(restored.strokes).toEqual(page.strokes);
    expect(restored.images[0]).toMatchObject({ ...page.images[0], rotation: 0 });
    expect(restored.images[1].group!.objects[0]).toMatchObject({
      ...page.images[1].group!.objects[0],
      rotation: 0,
    });
    expect(restored.reviews).toEqual(page.reviews);
  });
  it('applies relative crops on mixed sizes and original rotated crop boxes', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const landscape = doc.addPage([800, 500]);
    landscape.setCropBox(20, 30, 720, 400);
    landscape.setRotation(degrees(90));
    landscape.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const n = newNotebook();
    n.source = await doc.save();
    n.pages = [
      { ...annotated(), sourceIndex: 0 },
      { ...blankPage(800, 1440), sourceIndex: 1 },
      blankPage(300, 300),
    ];
    const next = await operatePages(n, [0, 1, 2], {
      action: 'crop',
      margins: { left: 10, right: 5, top: 15, bottom: 10 },
    });
    expect(next.pages.map((p) => [p.width, p.height])).toEqual([
      [340, 450],
      [680, 1080],
      [255, 225],
    ]);
    expect(next.pages[0].strokes[0].points[0]).toEqual([0, -30, 0.4]);
    expect(next.pages[0].images[0].y).toEqual(70);
    expect(n.pages[0].width).toEqual(400);
    const parsed = await PDFDocument.load(next.source!);
    expect(exportPageGeometry(parsed.getPage(1)).width).toBe(680);
    expect(validNotebook(next)).toBe(true);
    await expect(exportPdf(next)).resolves.toBeInstanceOf(Uint8Array);
  });
  it('only modifies selected pages and supports current/all/range without ambiguous empty ranges', async () => {
    const n = newNotebook();
    n.pages = [annotated(), blankPage(800, 400), blankPage(300, 300)];
    expect(scopePages('current', '', 1, 3)).toEqual([1]);
    expect(scopePages('all', '', 1, 3)).toEqual([0, 1, 2]);
    expect(scopePages('range', '1, 3', 1, 3)).toEqual([0, 2]);
    expect(() => scopePages('range', '', 1, 3)).toThrow('page-range');
    const next = await operatePages(n, [1], { action: 'rotate', angle: 90 });
    expect(next.pages[0]).toBe(n.pages[0]);
    expect(next.pages[1].width).toBe(400);
    expect(historyTarget(n, next, n.pages[0].id)).toBe(1);
    await expect(
      operatePages(n, [0], { action: 'crop', margins: { left: 90, right: 20, top: 0, bottom: 0 } }),
    ).rejects.toThrow('crop-range');
  });
  it('persists editable reviews, clones IDs and exports Unicode standard review annotations', async () => {
    const n = newNotebook();
    n.pages = [annotated()];
    expect(validNotebook(n)).toBe(true);
    const cloned = clonePage(n.pages[0]);
    expect(cloned.reviews![0].id).not.toBe(n.pages[0].reviews![0].id);
    expect(cloned.reviews![0].region).toEqual(n.pages[0].reviews![0].region);
    const packed = await packPdfExport(n, new AbortController().signal);
    const unpacked = unpackPdfExport(structuredClone(packed.notebook));
    expect(unpacked.pages[0].reviews).toEqual(n.pages[0].reviews);
    const output = await PDFDocument.load(await exportPdf(n));
    const annotations = output
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((a) => output.context.lookup(a, PDFDict));
    const square = annotations.find((a) => a.get(PDFName.of('Subtype')) === PDFName.of('Square'))!;
    expect(square.lookup(PDFName.of('Contents'))!.toString()).toContain('FEFF');
    expect(square.has(PDFName.of('Popup'))).toBe(true);
    expect(historyTarget(n, { ...n, pages: [{ ...n.pages[0], reviews: [] }] }, n.pages[0].id)).toBe(
      0,
    );
  });
});
