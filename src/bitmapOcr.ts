import type { PDFDocumentProxy } from './pdfTypes';
import { isPicture, type Page, type PlacedImage } from './model';
import { getPdfImages } from './pdfNight';
import { bitmapPdfDecoder } from './bitmapPdfDecoder';
import { polygonBox, transformPolygon, type ImagePolygon } from './pdfNightGeometry';
import { normalizeOcr, type OcrAnnotation, type OcrLine } from './ocrLayout';
import { runBitmapJobs } from './bitmapOcrPool';
import { recognitionImageSize } from './recognitionImageSize';
import { abortWait } from './abortWait';
export interface BitmapRecognition {
  text?: string;
  lines?: OcrLine[];
  engine: string;
  timing?: Partial<
    Record<'totalMs' | 'layoutMs' | 'inferenceMs' | 'compileMs' | 'serviceMs', number>
  >;
}
type Recognize = (image: string, lane: number) => Promise<BitmapRecognition>;
export interface BitmapInventory {
  total: number;
  parsed: number;
  /** Geometry only; keep it for this dialog so long documents need no second operator-list pass. */
  pdfImages: Map<string, ImagePolygon[]>;
}
export async function inspectBitmapPages(
  pages: Page[],
  pdf: PDFDocumentProxy | null,
  signal: AbortSignal,
): Promise<BitmapInventory> {
  const inventory: BitmapInventory = { total: 0, parsed: 0, pdfImages: new Map() };
  const countObject = (image: PlacedImage) => {
    if (image.group) image.group.objects.forEach(countObject);
    else if (isPicture(image)) {
      inventory.total++;
      if (image.ocr) inventory.parsed++;
    }
  };
  for (const page of pages) {
    signal.throwIfAborted();
    if (pdf && page.sourceIndex !== null) {
      const polygons = await abortWait(getPdfImages(pdf, page.sourceIndex), signal);
      signal.throwIfAborted();
      inventory.pdfImages.set(page.id, polygons);
      const parsed = new Set(page.bitmapOcr?.map((b) => b.imageIndex));
      for (const [i, polygon] of polygons.entries()) {
        const box = polygonBox(polygon);
        if (box.width <= 0 || box.height <= 0) continue;
        inventory.total++;
        if (parsed.has(i)) inventory.parsed++;
      }
    }
    page.images.forEach(countObject);
  }
  return inventory;
}
/** Decode only the active lanes; completed text is merged by stable image/path. */
export async function scanBitmapPages(
  pages: Page[],
  pdf: PDFDocumentProxy | null,
  options: {
    signal: AbortSignal;
    replace: boolean;
    recognize: Recognize;
    onPage: (page: Page) => void;
    onImage: (alreadyParsed: boolean) => void;
    inventory?: BitmapInventory;
    concurrency?: number;
  },
) {
  const { signal } = options;
  const decoder = pdf ? bitmapPdfDecoder(pdf, signal) : null;
  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency || 1)));
  const lanes = Array.from({ length: concurrency }, () => ({
    source: document.createElement('canvas'),
    input: document.createElement('canvas'),
  }));
  let pictureDecode: Promise<unknown> = Promise.resolve();
  const recognize = async (lane: number): Promise<OcrAnnotation> => {
    signal.throwIfAborted();
    const { source, input } = lanes[lane];
    const { width, height } = recognitionImageSize(
      source.width,
      source.height,
      Math.min(1, 4096 / Math.max(source.width, source.height)),
    );
    input.width = width;
    input.height = height;
    const ctx = input.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    try {
      const result = await options.recognize(input.toDataURL('image/png'), lane);
      signal.throwIfAborted();
      return normalizeOcr(result.text ?? '', result.lines, width, height, result.engine);
    } finally {
      source.width = source.height = input.width = input.height = 1;
    }
  };
  const updateObject = (
    images: PlacedImage[],
    path: number[],
    ocr: OcrAnnotation,
  ): PlacedImage[] => {
    const [index, ...rest] = path,
      image = images[index];
    const next = [...images];
    next[index] = rest.length
      ? {
          ...image,
          group: { ...image.group!, objects: updateObject(image.group!.objects, rest, ocr) },
        }
      : { ...image, ocr };
    return next;
  };
  const queued = async function* () {
    for (const page of pages) {
      signal.throwIfAborted();
      let next = page;
      const jobs: ((lane: number) => Promise<void>)[] = [];
      if (pdf && page.sourceIndex !== null) {
        const p = await abortWait(pdf.getPage(page.sourceIndex + 1), signal),
          viewport = p.getViewport({ scale: 1 });
        const polygons =
          options.inventory?.pdfImages.get(page.id) ??
          (await abortWait(getPdfImages(pdf, page.sourceIndex), signal));
        const parsed = new Set(page.bitmapOcr?.map((b) => b.imageIndex));
        for (const [imageIndex, polygon] of polygons.entries()) {
          if (!options.replace && parsed.has(imageIndex)) continue;
          const projected = transformPolygon(polygon, viewport.transform),
            box = polygonBox(projected);
          if (box.width <= 0 || box.height <= 0) continue;
          jobs.push(async (lane) => {
            const decoded = await decoder!.draw(page.sourceIndex!, imageIndex, lanes[lane].source);
            if (!decoded) throw new Error('PDF 位图无法解码，已保留此前完成的结果');
            const result = await recognize(lane);
            next = {
              ...next,
              bitmapOcr: [
                ...(next.bitmapOcr ?? []).filter((b) => b.imageIndex !== imageIndex),
                { imageIndex, polygon: projected, result },
              ].sort((a, b) => a.imageIndex - b.imageIndex),
            };
            options.onPage(next);
            options.onImage(parsed.has(imageIndex));
          });
        }
      }
      const enqueue = (image: PlacedImage, path: number[]) => {
        if (image.group) {
          image.group.objects.forEach((child, i) => enqueue(child, [...path, i]));
          return;
        }
        if (!isPicture(image) || (image.ocr && !options.replace)) return;
        jobs.push(async (lane) => {
          const decode = pictureDecode.then(async () => {
            signal.throwIfAborted();
            const bitmap = await createImageBitmap(
              await (await fetch(image.data, { signal })).blob(),
            );
            try {
              signal.throwIfAborted();
              const { source } = lanes[lane],
                { width, height } = recognitionImageSize(bitmap.width, bitmap.height);
              source.width = width;
              source.height = height;
              source.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
            } finally {
              bitmap.close();
            }
          });
          pictureDecode = decode.catch(() => {});
          await decode;
          const ocr = await recognize(lane);
          next = { ...next, images: updateObject(next.images, path, ocr) };
          options.onPage(next);
          options.onImage(!!image.ocr);
        });
      };
      page.images.forEach((image, i) => enqueue(image, [i]));
      for (const job of jobs) yield job;
    }
  };
  try {
    await runBitmapJobs(queued(), concurrency, signal);
  } finally {
    lanes.forEach(({ source, input }) => {
      source.width = source.height = input.width = input.height = 1;
    });
    await decoder?.close();
  }
}
