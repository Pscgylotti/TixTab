import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import type { Page } from './model';
export interface CopiedPage {
  page: Page;
  source: Uint8Array | null;
}
/** Source parsing lives in a disposable worker, never in the page clipboard. */
export async function extractPage(source: Uint8Array | null, page: Page): Promise<CopiedPage> {
  if (page.pdfEdits?.length) throw Error('pending-pdf-edits');
  if (page.sourceIndex === null) return { page, source: null };
  if (!source) throw Error('pdf-missing');
  const input = await PDFDocument.load(source, { updateMetadata: false }),
    selected = input.getPage(page.sourceIndex);
  // Scrub foreign destinations BEFORE copying; otherwise a GoTo/field parent can
  // recursively retain other pages. Keep image/text resources and URI actions.
  for (const ref of selected.node.Annots()?.asArray() ?? []) {
    const a = input.context.lookup(ref);
    if (!(a instanceof PDFDict)) continue;
    a.delete(PDFName.of('Dest'));
    a.delete(PDFName.of('AA'));
    if (a.lookupMaybe(PDFName.of('A'), PDFDict)?.get(PDFName.of('S')) === PDFName.of('GoTo'))
      a.delete(PDFName.of('A'));
    if (a.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
      a.set(PDFName.of('Subtype'), PDFName.of('Stamp'));
      a.delete(PDFName.of('Parent'));
      a.set(PDFName.of('F'), input.context.obj(4));
    }
  }
  const output = await PDFDocument.create(),
    [copy] = await output.copyPages(input, [page.sourceIndex]);
  output.addPage(copy);
  return {
    page: { ...page, sourceIndex: 0 },
    source: await output.save({ updateFieldAppearances: false }),
  };
}
