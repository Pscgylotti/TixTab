import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import type { Page } from './model';
export interface CopiedPage {
  page: Page;
  pages?: Page[];
  source: Uint8Array | null;
}
/** Source parsing lives in a disposable worker, never in the page clipboard. */
export async function extractPage(source: Uint8Array | null, page: Page): Promise<CopiedPage> {
  const result = await extractPages(source, [page]);
  return { page: result.page, source: result.source };
}
export async function extractPages(source: Uint8Array | null, pages: Page[]): Promise<CopiedPage> {
  if (!pages.length) throw Error('page-missing');
  if (pages.some((page) => page.pdfEdits?.length)) throw Error('pending-pdf-edits');
  const indices = [
    ...new Set(pages.flatMap((page) => (page.sourceIndex === null ? [] : [page.sourceIndex]))),
  ];
  if (!indices.length) return { page: pages[0], pages, source: null };
  if (!source) throw Error('pdf-missing');
  const input = await PDFDocument.load(source, { updateMetadata: false });
  // Scrub foreign destinations BEFORE copying; otherwise a GoTo/field parent can
  // recursively retain other pages. Keep image/text resources and URI actions.
  for (const index of indices)
    for (const ref of input.getPage(index).node.Annots()?.asArray() ?? []) {
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
  const output = await PDFDocument.create();
  for (const copy of await output.copyPages(input, indices)) output.addPage(copy);
  const mapping = new Map(indices.map((index, i) => [index, i]));
  const copied = pages.map((page) => ({
    ...page,
    sourceIndex: page.sourceIndex === null ? null : mapping.get(page.sourceIndex)!,
  }));
  return {
    page: copied[0],
    pages: copied,
    source: await output.save({ updateFieldAppearances: false }),
  };
}
