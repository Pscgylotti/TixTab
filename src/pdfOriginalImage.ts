import type { PDFDocumentProxy } from 'pdfjs-dist';
import { imagePolygons } from './pdfNightGeometry';

type DecodedImage = {
  width: number;
  height: number;
  kind?: number;
  bitmap?: ImageBitmap;
  data?: Uint8Array | Uint8ClampedArray;
};

/** Source pixels, color conversion and masks; never a screenshot of page overlays. */
export async function drawPdfOriginalImage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  imageIndex: number,
  output: HTMLCanvasElement,
  signal: AbortSignal,
  maxPixels = 64_000_000,
): Promise<boolean> {
  if ((pdf as unknown as { tixtabBackend?: string }).tixtabBackend === 'pdfium') {
    const { createPdfiumImageDecoder } = await import('./pdfiumRaster');
    const decoder = createPdfiumImageDecoder(pdf, signal, maxPixels);
    try {
      return await decoder.draw(pageIndex, imageIndex, output);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Error) || error.message !== 'PDFium image compatibility required')
        throw error;
    } finally {
      decoder.close();
    }
    // Compatibility pixels also belong to a short-lived worker. Do not load
    // a full operator list or decoded images into the reader's legacy index.
    const { bitmapPdfLegacyDecoder } = await import('./bitmapPdfLegacyDecoder');
    const compatibility = bitmapPdfLegacyDecoder(pdf, signal, maxPixels);
    try {
      return await compatibility.draw(pageIndex, imageIndex, output);
    } finally {
      await compatibility.close();
    }
  }
  const page = await pdf.getPage(pageIndex + 1),
    ops = await page.getOperatorList(),
    { OPS } = await import('pdfjs-dist');
  let count = 0,
    location: { operatorIndex: number; groupIndex?: number } | undefined;
  imagePolygons(ops, OPS, (_, operatorIndex, groupIndex) => {
    if (count++ === imageIndex) location = { operatorIndex, groupIndex };
  });
  if (!location || signal.aborted) return false;
  const { operatorIndex, groupIndex } = location,
    fn = ops.fnArray[operatorIndex],
    args = ops.argsArray[operatorIndex];
  let image: DecodedImage;
  if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
    const id = args[0] as string,
      objects = id.startsWith('g_') ? page.commonObjs : page.objs;
    image = await new Promise<DecodedImage>((resolve, reject) => {
      const finish = (value?: DecodedImage) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (value) resolve(value);
        else reject(new Error('PDF image unavailable'));
      };
      const abort = () => finish(),
        timer = setTimeout(() => finish(), 3000);
      signal.addEventListener('abort', abort, { once: true });
      objects.get(id, (value: DecodedImage) => finish(value));
    });
  } else image = args[0] as DecodedImage;
  if (signal.aborted || !image?.width || !image.height) return false;
  const crop =
    fn === OPS.paintInlineImageXObjectGroup
      ? (args[1][groupIndex ?? 0] as { x: number; y: number; w: number; h: number })
      : { x: 0, y: 0, w: image.width, h: image.height };
  // Avoid a pathological source allocation on a low-memory tablet. The caller
  // has a bounded high-resolution region fallback for oversized/unsupported images.
  if (crop.w * crop.h > 64_000_000 || Math.max(crop.w, crop.h) > 32767) return false;
  const scale = Math.min(1, Math.sqrt(maxPixels / crop.w / crop.h));
  output.width = Math.max(1, Math.floor(crop.w * scale));
  output.height = Math.max(1, Math.floor(crop.h * scale));
  const ctx = output.getContext('2d')!;
  if (image.bitmap) {
    ctx.drawImage(image.bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, output.width, output.height);
    return true;
  }
  if (!image.data || ![1, 2, 3].includes(image.kind ?? 0)) return false;
  // Convert at most 64 rows at once; do not allocate another full RGBA source.
  const stripe = scale < 1 ? document.createElement('canvas') : null;
  try {
    for (let top = 0; top < crop.h; top += 64) {
      const rows = Math.min(64, crop.h - top),
        pixels = ctx.createImageData(crop.w, rows);
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < crop.w; x++) {
          const source = (crop.y + top + y) * image.width + crop.x + x,
            dest = (y * crop.w + x) * 4;
          if (image.kind === 1) {
            const byte = (crop.y + top + y) * Math.ceil(image.width / 8) + ((crop.x + x) >> 3),
              gray = image.data[byte] & (128 >> ((crop.x + x) & 7)) ? 255 : 0;
            pixels.data[dest] = pixels.data[dest + 1] = pixels.data[dest + 2] = gray;
          } else {
            const at = source * (image.kind === 2 ? 3 : 4);
            pixels.data[dest] = image.data[at];
            pixels.data[dest + 1] = image.data[at + 1];
            pixels.data[dest + 2] = image.data[at + 2];
          }
          pixels.data[dest + 3] = image.kind === 3 ? image.data[source * 4 + 3] : 255;
        }
      if (stripe) {
        stripe.width = crop.w;
        stripe.height = rows;
        stripe.getContext('2d')!.putImageData(pixels, 0, 0);
        const y0 = Math.round((top * output.height) / crop.h),
          y1 = Math.round(((top + rows) * output.height) / crop.h);
        if (y1 > y0) ctx.drawImage(stripe, 0, 0, crop.w, rows, 0, y0, output.width, y1 - y0);
      } else ctx.putImageData(pixels, 0, top);
    }
  } finally {
    if (stripe) stripe.width = stripe.height = 1;
  }
  return true;
}
