import { PDFDocument } from 'pdf-lib';

/** One-based input; preserve user ordering, remove duplicate page numbers. */
export function parsePageRange(value: string, count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || value.length > 2048) throw Error('page-range');
  if (!value.trim()) return Array.from({ length: count }, (_, i) => i);
  const result = new Set<number>();
  for (const token of value.split(/[,，]/)) {
    const match = token.trim().match(/^(\d+)\s*(?:[-–—]\s*(\d+))?$/);
    if (!match) throw Error('page-range');
    const first = Number(match[1]),
      last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last > count) throw Error('page-range');
    for (let page = first; page <= last; page++) result.add(page - 1);
  }
  return [...result];
}
export async function appendPdfSources(
  source: Uint8Array | null,
  imports: { bytes: Uint8Array; pages: number[] }[],
) {
  const output = source
    ? await PDFDocument.load(source, { updateMetadata: false })
    : await PDFDocument.create();
  const indices: number[] = [];
  for (const entry of imports) {
    const document = await PDFDocument.load(entry.bytes, { updateMetadata: false });
    if (
      !entry.pages.length ||
      entry.pages.some((i) => !Number.isInteger(i) || i < 0 || i >= document.getPageCount())
    )
      throw Error('page-range');
    // Preserve imported form appearance without leaving orphaned cross-document fields.
    if (document.getForm().getFields().length)
      document.getForm().flatten({ updateFieldAppearances: false });
    for (const page of await output.copyPages(document, entry.pages)) {
      indices.push(output.getPageCount());
      output.addPage(page);
    }
  }
  return { source: await output.save(), indices };
}
