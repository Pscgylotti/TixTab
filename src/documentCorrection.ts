import { hiddenSourceBitmap } from './correctedBitmap';
import { inkLayerIndex } from './pageLayers';
import type { PDFDocumentProxy } from './pdfTypes';
import { isPicture, uid, type Page, type PlacedImage } from './model';
import { groupLeaves } from './objectGroup';
import { bitmapPdfDecoder } from './bitmapPdfDecoder';
import { getPdfImages } from './pdfNight';
import { polygonBox, transformPolygon } from './pdfNightGeometry';
import { recognitionImageSize } from './recognitionImageSize';
import { runLocalDocumentTool } from './localDocumentTools';
export interface CorrectionTarget {
  pageId: string;
  imageIndex?: number;
  objectId?: string;
  polygon: number[];
}
export async function correctionTargets(
  pages: Page[],
  pdf: PDFDocumentProxy | null,
  scanOnly: boolean,
  signal: AbortSignal,
) {
  const targets: CorrectionTarget[] = [];
  for (const page of pages) {
    signal.throwIfAborted();
    if (pdf && page.sourceIndex !== null) {
      const p = await pdf.getPage(page.sourceIndex + 1),
        viewport = p.getViewport({ scale: 1 });
      const polygons = await getPdfImages(pdf, page.sourceIndex);
      for (const [imageIndex, polygon] of polygons.entries()) {
        if (hiddenSourceBitmap(page, imageIndex)) continue;
        const projected = transformPolygon(polygon, viewport.transform),
          box = polygonBox(projected);
        if (
          box.width * box.height <= 0 ||
          (scanOnly && box.width * box.height < page.width * page.height * 0.6)
        )
          continue;
        targets.push({ pageId: page.id, imageIndex, polygon: projected });
      }
    }
    for (const object of page.images.flatMap(groupLeaves)) {
      if (
        !isPicture(object) ||
        (scanOnly && object.width * object.height < page.width * page.height * 0.6)
      )
        continue;
      const { x, y, width: w, height: h } = object;
      targets.push({
        pageId: page.id,
        objectId: object.id,
        polygon: [x, y, x + w, y, x + w, y + h, x, y + h],
      });
    }
  }
  signal.throwIfAborted();
  return targets;
}
export async function correctionInput(
  page: Page,
  target: CorrectionTarget,
  pdf: PDFDocumentProxy | null,
  signal: AbortSignal,
) {
  const canvas = document.createElement('canvas');
  const decoder =
    target.imageIndex !== undefined && pdf ? bitmapPdfDecoder(pdf, signal, 4_000_000) : null;
  let bitmap: ImageBitmap | undefined;
  try {
    if (decoder && page.sourceIndex !== null) {
      if (!(await decoder.draw(page.sourceIndex, target.imageIndex!, canvas)))
        throw Error('image-size');
    } else {
      const image = page.images.flatMap(groupLeaves).find((i) => i.id === target.objectId);
      if (!image) throw Error('element-stale');
      const swap = (image.rotation ?? 0) % 180,
        size = recognitionImageSize(
          swap ? image.height : image.width,
          swap ? image.width : image.height,
          2.5,
        );
      const blob = await (await fetch(image.data, { signal })).blob();
      bitmap = await createImageBitmap(blob, {
        resizeWidth: size.width,
        resizeHeight: size.height,
      });
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
    }
    signal.throwIfAborted();
    return canvas.toDataURL('image/png');
  } finally {
    bitmap?.close();
    canvas.width = canvas.height = 1;
    await decoder?.close();
  }
}
function replaceObject(
  images: PlacedImage[],
  id: string,
  data: string,
  model: string,
): PlacedImage[] {
  return images.map((image) =>
    image.id === id
      ? { ...image, data, displayData: undefined, ocr: undefined, correction: { model } }
      : image.group
        ? {
            ...image,
            displayData: undefined,
            group: { ...image.group, objects: replaceObject(image.group.objects, id, data, model) },
          }
        : image,
  );
}
/** Keep original PDF bytes and annotations; the corrected image is an editable
 * replacement layer. Source OCR is invalidated, and hidden originals are not
 * re-counted or re-recognized behind their replacement. */
export async function applyCorrection(
  page: Page,
  target: CorrectionTarget,
  data: string,
  model: string,
  signal: AbortSignal,
): Promise<Page> {
  if (target.objectId)
    return {
      ...page,
      score: undefined,
      images: replaceObject(page.images, target.objectId, data, model),
    };
  const box = polygonBox(target.polygon),
    image = await createImageBitmap(await (await fetch(data, { signal })).blob()),
    canvas = document.createElement('canvas');
  try {
    const size = recognitionImageSize(
      box.width,
      box.height,
      Math.min(image.width / Math.max(1, box.width), image.height / Math.max(1, box.height)),
    );
    canvas.width = size.width;
    canvas.height = size.height;
    const p = target.polygon,
      scale = size.scale,
      ctx = canvas.getContext('2d')!;
    // PDF image-space bottom-left/top-left are opposite canvas row order.
    ctx.setTransform(
      ((p[4] - p[6]) * scale) / image.width,
      ((p[5] - p[7]) * scale) / image.width,
      ((p[0] - p[6]) * scale) / image.height,
      ((p[1] - p[7]) * scale) / image.height,
      (p[6] - box.x) * scale,
      (p[7] - box.y) * scale,
    );
    ctx.drawImage(image, 0, 0);
    signal.throwIfAborted();
    const replacement: PlacedImage = {
      id: uid(),
      kind: 'image',
      data: canvas.toDataURL('image/png'),
      ...box,
      correction: { model, sourceImageIndex: target.imageIndex },
    };
    const at = inkLayerIndex(page);
    return {
      ...page,
      score: undefined,
      images: [...page.images.slice(0, at), replacement, ...page.images.slice(at)],
      inkLayer: at + 1,
      bitmapOcr: page.bitmapOcr?.filter((o) => o.imageIndex !== target.imageIndex),
    };
  } finally {
    image.close();
    canvas.width = canvas.height = 1;
  }
}
export async function correctTarget(
  page: Page,
  target: CorrectionTarget,
  pdf: PDFDocumentProxy | null,
  mode: 'scan' | 'photo' | 'auto',
  device: 'AUTO' | 'CPU' | 'GPU' | 'NPU',
  signal: AbortSignal,
) {
  const original = await correctionInput(page, target, pdf, signal);
  const result = await runLocalDocumentTool(
    { action: 'correct', engine: 'uvdoc', mode, device, image: original },
    signal,
  );
  if (!result?.image) throw Error('correction-failed');
  return {
    original,
    image: result.image,
    model: result.model || 'UVDoc',
    device: result.device,
    fallback: result.fallback,
  };
}
