import { test, expect } from 'vitest';
import { PDFDocument, PDFName, PDFHexString, PDFArray, PDFDict } from 'pdf-lib';
import { exportPdf, exportPageGeometry, SignedPdfExportError } from './pdfExport';
import type { Notebook } from './model';
const name = (value: string) => PDFName.of(value);
async function notebook(
  doc: PDFDocument,
  indices = doc.getPages().map((_, i) => i),
): Promise<Notebook> {
  return {
    version: 1,
    name: 'fixture',
    source: await doc.save({ updateFieldAppearances: false }),
    pages: indices.map((i) => ({
      id: String(i),
      sourceIndex: i,
      ...exportPageGeometry(doc.getPage(i)),
      strokes: [],
      images: [],
      paper: 'plain',
    })),
  };
}

test('no-op signed export returns exact original bytes; modified copy requires explicit opt-in', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 500]);
  const signature = doc.context.register(
    doc.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: PDFHexString.of('00') }),
  );
  doc.catalog.set(name('Perms'), doc.context.obj({ DocMDP: signature }));
  const n = await notebook(doc);
  expect(await exportPdf(n)).toEqual(n.source);
  n.pages[0].strokes.push({
    id: 'ink',
    tool: 'pen',
    color: '#ff0000',
    size: 4,
    points: [
      [10, 10, 0.5],
      [20, 20, 0.5],
    ],
  });
  await expect(exportPdf(n)).rejects.toBeInstanceOf(SignedPdfExportError);
  const copy = await PDFDocument.load(await exportPdf(n, { allowSignatureInvalidation: true }));
  expect(copy.getPageCount()).toBe(1);
  expect(copy.catalog.has(name('Perms'))).toBe(true);
  expect(n.source).toEqual(await doc.save({ updateFieldAppearances: false }));
});

test('multi-page widgets retain canonical value, appearance and only remaining page bindings', async () => {
  const doc = await PDFDocument.create(),
    a = doc.addPage([300, 500]),
    b = doc.addPage([300, 500]),
    form = doc.getForm(),
    field = form.createTextField('shared.value');
  field.setText('kept value');
  field.addToPage(a, { x: 20, y: 20, width: 120, height: 30 });
  field.addToPage(b, { x: 30, y: 30, width: 120, height: 30 });
  form.updateFieldAppearances();
  const n = await notebook(doc, [1]),
    out = await PDFDocument.load(await exportPdf(n)),
    kept = out.getForm().getTextField('shared.value');
  expect(kept.getText()).toBe('kept value');
  const kids = kept.acroField.Kids()!;
  expect(kids.size()).toBe(1);
  const widget = kids.lookup(0, PDFDict);
  expect(widget.get(name('P'))?.toString()).toBe(out.getPage(0).ref.toString());
  expect(widget.lookup(name('AP'), PDFDict).has(name('N'))).toBe(true);
  expect(
    out.context.enumerateIndirectObjects().some(([ref]) => ref.toString() === a.ref.toString()),
  ).toBe(false);
  kept.setText('edited later');
  const edited = await PDFDocument.load(await out.save());
  expect(edited.getForm().getTextField('shared.value').getText()).toBe('edited later');
});

test('reparenting materializes inherited boxes, rotation and resources without flattening', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([300, 500]);
  page.setCropBox(10, 20, 250, 450);
  const parent = page.node.Parent()!;
  for (const key of ['MediaBox', 'CropBox', 'Resources']) {
    parent.set(name(key), page.node.get(name(key))!);
    page.node.delete(name(key));
  }
  const n = await notebook(doc),
    original = n.pages[0];
  n.pages.unshift({
    id: 'blank',
    sourceIndex: null,
    width: 200,
    height: 300,
    strokes: [],
    images: [],
    paper: 'plain',
  });
  const out = await PDFDocument.load(await exportPdf(n));
  expect(exportPageGeometry(out.getPage(1))).toMatchObject({
    width: original.width,
    height: original.height,
  });
  expect(out.getPage(1).node.Resources()).toBeDefined();
});

test('empty source page accepts ink; removed local links do not retain deleted pages', async () => {
  const doc = await PDFDocument.create(),
    a = doc.addPage([300, 500]),
    b = doc.addPage([300, 500]);
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 10, 100, 30],
      A: { S: 'GoTo', D: [b.ref, 'Fit'] },
      P: a.ref,
    }),
  );
  a.node.addAnnot(link);
  doc.catalog.set(name('OpenAction'), doc.context.obj([b.ref, 'Fit']));
  const n = await notebook(doc, [0]);
  n.pages[0].strokes.push({
    id: 'ink',
    tool: 'pen',
    color: '#ff0000',
    size: 4,
    points: [
      [10, 10, 0.5],
      [20, 20, 0.5],
    ],
  });
  const out = await PDFDocument.load(await exportPdf(n));
  expect(out.getPage(0).node.Annots()?.size()).toBe(1);
  expect(out.getPage(0).node.Annots()!.lookup(0, PDFDict).get(name('Subtype'))?.toString()).toBe(
    '/Stamp',
  );
  expect(out.catalog.has(name('OpenAction'))).toBe(false);
  expect(
    out.context.enumerateIndirectObjects().some(([ref]) => ref.toString() === b.ref.toString()),
  ).toBe(false);
});

test('invalid source references or altered source dimensions fail instead of exporting misaligned content', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 500]);
  const n = await notebook(doc);
  n.pages[0].width = 301;
  await expect(exportPdf(n)).rejects.toThrow('页面尺寸');
  n.pages[0].width = 300;
  n.pages.push({ ...n.pages[0], id: 'duplicate' });
  await expect(exportPdf(n)).rejects.toThrow('重复引用');
  n.pages.pop();
  n.pages[0].sourceIndex = 100;
  await expect(exportPdf(n)).rejects.toThrow('不存在');
});

test('nested destination trees, legacy targets and local action cleanup preserve retained navigation', async () => {
  const doc = await PDFDocument.create(),
    a = doc.addPage([300, 500]),
    b = doc.addPage([300, 500]),
    c = doc.addPage([300, 500]);
  const leaf1 = doc.context.register(
    doc.context.obj({
      Names: [
        PDFHexString.fromText('Akeep'),
        [0, 'Fit'],
        PDFHexString.fromText('Bdrop'),
        [1, 'Fit'],
      ],
      Limits: [PDFHexString.fromText('Akeep'), PDFHexString.fromText('Bdrop')],
    }),
  );
  const leaf2 = doc.context.register(
    doc.context.obj({
      Names: [
        PDFHexString.fromText('Ckeep'),
        [c.ref, 'Fit'],
        PDFHexString.fromText('Ddrop'),
        [b.ref, 'Fit'],
      ],
      Limits: [PDFHexString.fromText('Ckeep'), PDFHexString.fromText('Ddrop')],
    }),
  );
  doc.catalog.set(name('Names'), doc.context.obj({ Dests: { Kids: [leaf1, leaf2] } }));
  doc.catalog.set(
    name('Dests'),
    doc.context.obj({ oldRemoved: { D: [b.ref, 'Fit'] }, oldKept: { D: [a.ref, 'Fit'] } }),
  );
  doc.catalog.set(
    name('OpenAction'),
    doc.context.obj({ S: 'GoTo', D: PDFHexString.fromText('oldKept') }),
  );
  a.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [10, 10, 100, 30],
        Dest: name('oldRemoved'),
        P: a.ref,
      }),
    ),
  );
  a.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [10, 40, 100, 60],
        A: { S: 'GoToR', F: PDFHexString.fromText('other.pdf'), D: [1, 'Fit'] },
        P: a.ref,
      }),
    ),
  );
  a.node.set(
    name('AA'),
    doc.context.obj({
      O: { S: 'GoTo', D: [b.ref, 'Fit'] },
      C: { S: 'URI', URI: PDFHexString.fromText('https://example.com/') },
    }),
  );
  const out = await PDFDocument.load(await exportPdf(await notebook(doc, [2, 0])));
  const tree = out.catalog.lookup(name('Names'), PDFDict).lookup(name('Dests'), PDFDict),
    kids = tree.lookup(name('Kids'), PDFArray);
  expect(kids.size()).toBe(2);
  expect(
    tree
      .lookup(name('Limits'), PDFArray)
      .asArray()
      .map((raw) => (raw as PDFHexString).decodeText()),
  ).toEqual(['Akeep', 'Ckeep']);
  const first = kids.lookup(0, PDFDict).lookup(name('Names'), PDFArray);
  expect(first.size()).toBe(2);
  expect(first.lookup(1, PDFArray).get(0)?.toString()).toBe(out.getPage(1).ref.toString());
  const legacy = out.catalog.lookup(name('Dests'), PDFDict);
  expect(legacy.has(name('oldRemoved'))).toBe(false);
  expect(legacy.has(name('oldKept'))).toBe(true);
  const page = out.getPage(1);
  expect(page.node.Annots()?.size()).toBe(1);
  expect(
    page.node
      .Annots()!
      .lookup(0, PDFDict)
      .lookup(name('A'), PDFDict)
      .lookup(name('D'), PDFArray)
      .get(0)
      ?.toString(),
  ).toBe('1');
  const aa = page.node.lookup(name('AA'), PDFDict);
  expect(aa.has(name('O'))).toBe(false);
  expect(aa.has(name('C'))).toBe(true);
  expect(out.catalog.lookup(name('OpenAction'), PDFDict).has(name('D'))).toBe(true);
});
