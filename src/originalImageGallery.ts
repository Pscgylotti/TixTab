import type { Page } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import { getPdfImages } from './pdfNight';
import { transformPolygon } from './pdfNightGeometry';
export interface OriginalImageSelection {
  pageId: string;
  sourceIndex: number;
  imageIndex: number;
  polygon: number[];
}
/** Only metadata is visited while finding the neighbor. Pixels are decoded by
 * the viewer for the selected image, never prefetched for the whole document. */
export async function adjacentOriginalImage(
  pdf: PDFDocumentProxy,
  pages: readonly Pick<Page, 'id' | 'sourceIndex'>[],
  selected: OriginalImageSelection,
  direction: -1 | 1,
  signal: AbortSignal,
): Promise<OriginalImageSelection | null> {
  const start = pages.findIndex((p) => p.id === selected.pageId);
  if (start < 0) return null;
  for (let at = start; at >= 0 && at < pages.length; at += direction) {
    signal.throwIfAborted();
    const p = pages[at];
    if (p.sourceIndex === null) continue;
    const polygons = await getPdfImages(pdf, p.sourceIndex);
    signal.throwIfAborted();
    const index =
      at === start ? selected.imageIndex + direction : direction > 0 ? 0 : polygons.length - 1;
    if (index < 0 || index >= polygons.length) continue;
    const page = await pdf.getPage(p.sourceIndex + 1);
    signal.throwIfAborted();
    return {
      pageId: p.id,
      sourceIndex: p.sourceIndex,
      imageIndex: index,
      polygon: transformPolygon(polygons[index], page.getViewport({ scale: 1 }).transform),
    };
  }
  return null;
}
