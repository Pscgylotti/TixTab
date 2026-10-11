import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { appendPdfSources, parsePageRange } from './pdfInsertion';
import { svgCandidates } from './svgImport';

describe('PDF page insertion', () => {
  it('accepts all pages, ordered ranges and duplicate removal', () => {
    expect(parsePageRange('', 4)).toEqual([0, 1, 2, 3]);
    expect(parsePageRange('4, 1–2, 2', 4)).toEqual([3, 0, 1]);
    expect(parsePageRange('1，3—4', 4)).toEqual([0, 2, 3]);
  });
  it('rejects reversed, missing, fractional and out-of-bounds pages', () => {
    for (const value of ['0', '5', '3-2', '1,,2', '1.5', '1-9', '-1', '1;2'])
      expect(() => parsePageRange(value, 4)).toThrow();
  });
  it('appends selected pages while retaining existing field values and metadata', async () => {
    const base = await PDFDocument.create();
    base.setTitle('Preserved');
    const first = base.addPage([300, 400]);
    const field = base.getForm().createTextField('base-name');
    field.setText('Reader');
    field.addToPage(first);
    const incoming = await PDFDocument.create();
    incoming.addPage([410, 510]);
    incoming.addPage([420, 520]);
    incoming.addPage([430, 530]);
    const importedField = incoming.getForm().createTextField('import-name');
    importedField.setText('Static');
    importedField.addToPage(incoming.getPage(1));
    incoming.getForm().updateFieldAppearances(await incoming.embedFont(StandardFonts.Helvetica));
    const merged = await appendPdfSources(await base.save(), [
      { bytes: await incoming.save(), pages: [2, 1] },
    ]);
    expect(merged.indices).toEqual([1, 2]);
    const document = await PDFDocument.load(merged.source);
    expect(document.getPages().map((p) => p.getSize())).toEqual([
      { width: 300, height: 400 },
      { width: 430, height: 530 },
      { width: 420, height: 520 },
    ]);
    expect(document.getTitle()).toBe('Preserved');
    expect(document.getForm().getTextField('base-name').getText()).toBe('Reader');
    expect(document.getForm().getFields()).toHaveLength(1);
  });
  it('also inserts into a notebook without an original PDF', async () => {
    const incoming = await PDFDocument.create();
    incoming.addPage([200, 300]);
    const merged = await appendPdfSources(null, [{ bytes: await incoming.save(), pages: [0] }]);
    expect(merged.indices).toEqual([0]);
    expect((await PDFDocument.load(merged.source)).getPageCount()).toBe(1);
  });
  it('rejects invalid source indices before mutating the caller source', async () => {
    const input = await PDFDocument.create();
    input.addPage();
    const bytes = await input.save();
    await expect(appendPdfSources(bytes, [{ bytes, pages: [2] }])).rejects.toThrow('page-range');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
it('extracts only complete, bounded SVG candidates, including fenced responses', () => {
  expect(
    svgCandidates('```svg\n<svg viewBox="0 0 20 20"><rect width="5"/></svg>\n```'),
  ).toHaveLength(1);
  expect(svgCandidates('<svg><path d="M0 0"/>')).toEqual([]);
  expect(svgCandidates('<svg>' + 'x'.repeat(400_000) + '</svg>')).toEqual([]);
});
