import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts, PDFName, PDFString, PDFHexString, rgb, degrees } =
  createRequire(import.meta.url)('pdf-lib');
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function preservationFixture() {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('Preserved document title');
  doc.setAuthor('TixTab fixture');
  doc.setCreationDate(new Date('2024-03-02T12:00:00Z'));
  doc.setModificationDate(new Date('2024-03-02T12:00:00Z'));
  const form = doc.getForm(),
    pages = [];
  for (let i = 0; i < 5; i++) {
    const page = doc.addPage([400, 600]);
    page.setCropBox(20, 40, 300, 500);
    page.setRotation(degrees([0, 90, 180, 270, 0][i]));
    if (i === 1) page.node.set(PDFName.of('UserUnit'), doc.context.obj(2));
    page.drawText(i === 4 ? 'REMOVED_PAGE_PRIVATE_TEXT' : `Original page ${i + 1}`, {
      x: 50,
      y: 470,
      size: 17,
      font,
    });
    page.drawRectangle({ x: 50, y: 300, width: 70, height: 80, color: rgb(0.2, 0.4, 0.8) });
    const field = form.createTextField(`group.field-${i}`);
    field.setText(`value-${i}`);
    field.addToPage(page, { x: 50, y: 200, width: 160, height: 30, font, borderWidth: 1 });
    const note = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [250, 400, 275, 425],
        Contents: PDFString.of(`Original note ${i + 1}`),
        P: page.ref,
        F: 4,
      }),
    );
    page.node.addAnnot(note);
    pages.push(page);
  }
  const checkbox = form.createCheckBox('checked');
  checkbox.addToPage(pages[0], { x: 250, y: 200, width: 20, height: 20 });
  checkbox.check();
  form.updateFieldAppearances(font);
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 120, 210, 145],
      Border: [0, 0, 0],
      A: { S: 'URI', URI: PDFString.of('https://example.com/reference') },
      P: pages[0].ref,
    }),
  );
  pages[0].node.addAnnot(link);
  const retained = doc.context.obj([pages[3].ref, PDFName.of('Fit')]),
    removed = doc.context.obj([pages[4].ref, PDFName.of('Fit')]);
  for (const [name, dest] of [
    ['retained', retained],
    ['removed', removed],
  ])
    pages[0].node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [50, name === 'retained' ? 80 : 45, 210, name === 'retained' ? 105 : 70],
          Dest: PDFString.of(name),
          P: pages[0].ref,
        }),
      ),
    );
  doc.catalog.set(
    PDFName.of('Names'),
    doc.context.obj({
      Dests: { Names: [PDFString.of('removed'), removed, PDFString.of('retained'), retained] },
    }),
  );
  doc.catalog.set(PDFName.of('OpenAction'), retained);
  doc.catalog.set(
    PDFName.of('PageLabels'),
    doc.context.obj({
      Nums: [0, { S: 'r', P: PDFString.of('section-'), St: 3 }, 2, { S: 'D', St: 10 }],
    }),
  );
  const metadata = doc.context.register(
    doc.context.stream('<fixture>keep XMP</fixture>', { Type: 'Metadata', Subtype: 'XML' }),
  );
  doc.catalog.set(PDFName.of('Metadata'), metadata);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
// A signature dictionary exercises the export guard; it is not a valid
// cryptographic signature and cannot establish signature-verification support.
export async function signatureGuardFixture() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 500]);
  const signature = doc.context.register(
    doc.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: PDFHexString.of('00') }),
  );
  doc.catalog.set(PDFName.of('Perms'), doc.context.obj({ DocMDP: signature }));
  return doc.save({ updateFieldAppearances: false });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/preservation-source.pdf', await preservationFixture());
}
