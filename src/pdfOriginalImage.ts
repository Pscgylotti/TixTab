import type { PDFDocumentProxy } from './pdfTypes';
import { createPdfiumImageDecoder } from './pdfiumRaster';
/** Source pixels, color conversion and intrinsic masks; never page overlays. */
export async function drawPdfOriginalImage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  imageIndex: number,
  output: HTMLCanvasElement,
  signal: AbortSignal,
  maxPixels = 64_000_000,
): Promise<boolean> {
  const decoder = createPdfiumImageDecoder(pdf, signal, maxPixels);
  try {
    return await decoder.draw(pageIndex, imageIndex, output);
  } finally {
    decoder.close();
  }
}
