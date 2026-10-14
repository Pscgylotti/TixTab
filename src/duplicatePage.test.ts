import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { blankPage, validNotebook, type Notebook } from './model';
import { clonePage, duplicateNotebookPage } from './duplicatePage';
import { exportPdf } from './pdfExport';
import { PDFDict, PDFName, PDFHexString, PDFArray } from 'pdf-lib';
import { packPdfExport, unpackPdfExport } from './pdfExportSnapshot';
it('duplicates editable data independently and preserves the handwriting layer', () => {
  const original = blankPage();
  original.inkLayer = 0;
  original.strokes = [{ id: 's', tool: 'pen', color: '#000000', size: 2, points: [[1, 2, 0.5]] }];
  const copy = clonePage(original);
  copy.strokes[0].points[0][0] = 99;
  expect(copy.id).not.toBe(original.id);
  expect(copy.strokes[0].id).not.toBe('s');
  expect(original.strokes[0].points[0][0]).toBe(1);
  expect(copy.inkLayer).toBe(0);
});
it('gives copied PDF pages distinct sources and exports a valid duplicated document', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const n: Notebook = {
    version: 1,
    name: 'copy',
    source: await pdf.save(),
    pages: [{ ...blankPage(595, 842), sourceIndex: 0 }],
  };
  const copy = await duplicateNotebookPage(n, 0);
  expect(copy.pages.map((p) => p.sourceIndex)).toEqual([0, 1]);
  expect((await PDFDocument.load(await exportPdf(copy))).getPageCount()).toBe(2);
  expect((await PDFDocument.load(n.source!)).getPageCount()).toBe(1);
});
it('validates saved bookmarks while accepting old projects without them', () => {
  const n: Notebook = { version: 1, name: 'book', source: null, pages: [blankPage()] };
  expect(validNotebook(n)).toBe(true);
  expect(
    validNotebook({ ...n, bookmarks: [{ id: 'b', pageId: n.pages[0].id, title: 'Section' }] }),
  ).toBe(true);
  expect(validNotebook({ ...n, bookmarks: [{ id: 'b', pageId: 4, title: 'bad' }] })).toBe(false);
});
it('exports project bookmarks through the worker snapshot to the reordered page reference', async () => {
  const a = blankPage(),
    b = blankPage(),
    n: Notebook = {
      version: 1,
      name: 'bookmarks',
      source: null,
      pages: [b, a],
      bookmarks: [{ id: 'mark', pageId: a.id, title: '章节 alpha' }],
    };
  const packed = await packPdfExport(n, new AbortController().signal),
    output = await PDFDocument.load(await exportPdf(unpackPdfExport(packed.notebook)));
  const tree = output.catalog.lookup(PDFName.of('Outlines'), PDFDict),
    item = tree.lookup(PDFName.of('First'), PDFDict);
  expect(item.lookup(PDFName.of('Title'), PDFHexString).decodeText()).toBe('章节 alpha');
  expect(item.lookup(PDFName.of('Dest'), PDFArray).get(0)).toEqual(output.getPage(1).ref);
});
it('keeps copied internal links bound to pages in the actual PDF page tree', async () => {
  const doc = await PDFDocument.create(),
    a = doc.addPage([595, 842]),
    b = doc.addPage([595, 842]);
  a.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [0, 0, 20, 20],
          Dest: [b.ref, PDFName.of('Fit')],
        }),
      ),
    ]),
  );
  const n: Notebook = {
    version: 1,
    name: 'links',
    source: await doc.save(),
    pages: [
      { ...blankPage(595, 842), sourceIndex: 0 },
      { ...blankPage(595, 842), sourceIndex: 1 },
    ],
  };
  const duplicate = await duplicateNotebookPage(n, 0),
    output = await PDFDocument.load(await exportPdf(duplicate));
  const link = output.getPage(1).node.Annots()!.lookup(0, PDFDict),
    dest = link.lookup(PDFName.of('Dest'), PDFArray);
  expect(dest.get(0)).toEqual(output.getPage(2).ref);
});
