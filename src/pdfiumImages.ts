import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { multiply, transformPolygon } from './pdfNightGeometry';

/** Handles live only until the caller closes this native page. */
export async function nativeImages(api: WrappedPdfiumModule, page: number, check: () => void) {
  const m = api.pdfium,
    p = m.wasmExports.malloc(32);
  if (!p) throw new Error('PDFium image index allocation failed');
  const images: { object: number; polygon: number[]; width: number; height: number }[] = [];
  let visited = 0;
  const walk = async (container: number, form: boolean, parent: number[], depth: number) => {
    if (depth > 32) throw new Error('PDFium image nesting limit');
    const count = form
      ? api.FPDFFormObj_CountObjects(container)
      : api.FPDFPage_CountObjects(container);
    for (let i = 0; i < count && images.length < 4096; i++) {
      if (++visited > 100000) throw new Error('PDFium image object limit');
      if (visited % 256 === 0) await new Promise<void>((r) => setTimeout(r, 0));
      check();
      const object = form
          ? api.FPDFFormObj_GetObject(container, i)
          : api.FPDFPage_GetObject(container, i),
        type = api.FPDFPageObj_GetType(object);
      if (type !== 3 && type !== 5) continue;
      if (!api.FPDFPageObj_GetMatrix(object, p))
        throw new Error('PDFium image transform unavailable');
      const matrix = multiply(
        parent,
        Array.from({ length: 6 }, (_, j) => m.getValue(p + j * 4, 'float')),
      );
      if (!matrix.every(Number.isFinite)) continue;
      if (type === 5) await walk(object, true, matrix, depth + 1);
      else {
        if (
          !api.FPDFImageObj_GetImagePixelSize(object, p + 24, p + 28) ||
          !(m.getValue(p + 24, 'i32') > 0 && m.getValue(p + 28, 'i32') > 0)
        )
          throw new Error('PDFium image compatibility required');
        images.push({
          object,
          polygon: transformPolygon([0, 0, 1, 0, 1, 1, 0, 1], matrix),
          width: m.getValue(p + 24, 'i32'),
          height: m.getValue(p + 28, 'i32'),
        });
      }
    }
  };
  try {
    await walk(page, false, [1, 0, 0, 1, 0, 0], 0);
    return images;
  } finally {
    m.wasmExports.free(p);
  }
}

/** Normalize only the selected occurrence to source-pixel dimensions, retaining
 * PDF color conversion and soft masks. Restore the page object even on failure. */
export function nativeOriginalImage(
  api: WrappedPdfiumModule,
  document: number,
  page: number,
  image: { object: number; width: number; height: number },
  maxPixels: number,
) {
  const clip = api.FPDFPageObj_GetClipPath(image.object);
  // GetRenderedBitmap includes the occurrence's clip. That is not the full
  // source bitmap, and the public ABI cannot remove a clip from an object.
  if (clip && api.FPDFClipPath_CountPaths(clip) > 0)
    throw new Error('PDFium image compatibility required');
  if (
    !(image.width > 0 && image.height > 0) ||
    image.width * image.height > 64_000_000 ||
    Math.max(image.width, image.height) > 32767
  )
    return null;
  const scale = Math.min(1, Math.sqrt(maxPixels / image.width / image.height)),
    width = Math.max(1, Math.floor(image.width * scale)),
    height = Math.max(1, Math.floor(image.height * scale)),
    m = api.pdfium as typeof api.pdfium & { HEAPU8: Uint8Array },
    p = m.wasmExports.malloc(24);
  if (!p) throw new Error('PDFium image matrix allocation failed');
  let bitmap = 0,
    original: number[] | undefined,
    canvas: OffscreenCanvas | undefined;
  try {
    if (!api.FPDFPageObj_GetMatrix(image.object, p)) return null;
    original = Array.from({ length: 6 }, (_, j) => m.getValue(p + j * 4, 'float'));
    if (!api.FPDFImageObj_SetMatrix(image.object, width, 0, 0, height, 0, 0)) return null;
    bitmap = api.FPDFImageObj_GetRenderedBitmap(document, page, image.object);
    if (!bitmap) return null;
    const bw = api.FPDFBitmap_GetWidth(bitmap),
      bh = api.FPDFBitmap_GetHeight(bitmap),
      stride = api.FPDFBitmap_GetStride(bitmap),
      buffer = api.FPDFBitmap_GetBuffer(bitmap),
      format = api.FPDFBitmap_GetFormat(bitmap);
    if (bw !== width || bh !== height || format !== 4 || !buffer || stride < width * 4) return null;
    canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    for (let y = 0; y < height; y += 64) {
      const rows = Math.min(64, height - y),
        output = ctx.createImageData(width, rows);
      for (let row = 0; row < rows; row++)
        for (let x = 0; x < width; x++) {
          const src = buffer + (y + row) * stride + x * 4,
            dst = (row * width + x) * 4;
          output.data[dst] = m.HEAPU8[src + 2];
          output.data[dst + 1] = m.HEAPU8[src + 1];
          output.data[dst + 2] = m.HEAPU8[src];
          output.data[dst + 3] = m.HEAPU8[src + 3];
        }
      ctx.putImageData(output, 0, y);
    }
    return canvas.transferToImageBitmap();
  } finally {
    if (bitmap) api.FPDFBitmap_Destroy(bitmap);
    if (original)
      api.FPDFImageObj_SetMatrix(
        image.object,
        original[0],
        original[1],
        original[2],
        original[3],
        original[4],
        original[5],
      );
    m.wasmExports.free(p);
    if (canvas) canvas.width = canvas.height = 1;
  }
}
