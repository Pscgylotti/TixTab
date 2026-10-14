import type { PDFDocumentProxy } from 'pdfjs-dist';
import { isPicture, type Page, type PlacedImage } from './model';
import { getPdfImages } from './pdfNight';
import { drawPdfOriginalImage } from './pdfOriginalImage';
import { polygonBox, transformPolygon } from './pdfNightGeometry';
import { normalizeOcr, type OcrAnnotation, type OcrLine } from './ocrLayout';
export interface BitmapRecognition {
  text?: string;
  lines?: OcrLine[];
  engine: string;
}
type Recognize = (image: string) => Promise<BitmapRecognition>;
/** One bitmap at a time. Reuse models through the provider lane; retain only text/geometry. */
export async function scanBitmapPages(
  pages: Page[],
  pdf: PDFDocumentProxy | null,
  options: {
    signal: AbortSignal;
    replace: boolean;
    recognize: Recognize;
    onPage: (page: Page) => void;
    onImage: () => void;
  },
) {
  const { signal } = options;
  const source = document.createElement('canvas'),
    input = document.createElement('canvas');
  const recognize = async (): Promise<OcrAnnotation> => {
    signal.throwIfAborted();
    const scale = Math.min(
      1,
      Math.sqrt(4_000_000 / (source.width * source.height)),
      4096 / Math.max(source.width, source.height),
    );
    input.width = Math.max(1, Math.round(source.width * scale));
    input.height = Math.max(1, Math.round(source.height * scale));
    const ctx = input.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, input.width, input.height);
    ctx.drawImage(source, 0, 0, input.width, input.height);
    const result = await options.recognize(input.toDataURL('image/png'));
    signal.throwIfAborted();
    options.onImage();
    return normalizeOcr(result.text ?? '', result.lines, input.width, input.height, result.engine);
  };
  const scanObject = async (image: PlacedImage): Promise<PlacedImage> => {
    signal.throwIfAborted();
    if (image.group) {
      const children: PlacedImage[] = [];
      for (const child of image.group.objects) children.push(await scanObject(child));
      return children.some((child, i) => child !== image.group!.objects[i])
        ? { ...image, group: { ...image.group, objects: children } }
        : image;
    }
    if (!isPicture(image) || (image.ocr && !options.replace)) return image;
    const bitmap = await createImageBitmap(await (await fetch(image.data, { signal })).blob());
    try {
      const scale = Math.min(1, Math.sqrt(4_000_000 / (bitmap.width * bitmap.height)));
      source.width = Math.max(1, Math.round(bitmap.width * scale));
      source.height = Math.max(1, Math.round(bitmap.height * scale));
      source.getContext('2d')!.drawImage(bitmap, 0, 0, source.width, source.height);
    } finally {
      bitmap.close();
    }
    return { ...image, ocr: await recognize() };
  };
  try {
    for (const page of pages) {
      signal.throwIfAborted();
      let next = page;
      try {
        if (pdf && page.sourceIndex !== null) {
          const p = await pdf.getPage(page.sourceIndex + 1),
            viewport = p.getViewport({ scale: 1 });
          const polygons = await getPdfImages(pdf, page.sourceIndex);
          for (const [imageIndex, polygon] of polygons.entries()) {
            signal.throwIfAborted();
            if (!options.replace && next.bitmapOcr?.some((b) => b.imageIndex === imageIndex))
              continue;
            const projected = transformPolygon(polygon, viewport.transform),
              box = polygonBox(projected);
            if (box.width <= 0 || box.height <= 0) continue;
            const decoded = await drawPdfOriginalImage(
              pdf,
              page.sourceIndex,
              imageIndex,
              source,
              signal,
            );
            if (!decoded) throw new Error('PDF 位图无法解码，已保留此前完成的结果');
            const result = await recognize();
            next = {
              ...next,
              bitmapOcr: [
                ...(next.bitmapOcr ?? []).filter((b) => b.imageIndex !== imageIndex),
                { imageIndex, polygon: projected, result },
              ],
            };
          }
        }
        // Commit each completed picture to this page, including when a later picture is cancelled.
        for (let i = 0; i < page.images.length; i++) {
          const image = await scanObject(page.images[i]);
          if (image !== page.images[i]) {
            const images = [...next.images];
            images[i] = image;
            next = { ...next, images };
          }
        }
      } finally {
        if (next !== page) options.onPage(next);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    source.width = source.height = input.width = input.height = 1;
  }
}
