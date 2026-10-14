import type { PDFDocumentProxy } from 'pdfjs-dist';
import { trackPerformance, performanceLedger } from './performanceLedger';
import { imagePolygons, transformPolygon, polygonBox, type ImagePolygon } from './pdfNightGeometry';
const metadata = new WeakMap<PDFDocumentProxy, Map<number, Promise<ImagePolygon[]>>>();
export function getPdfImages(pdf: PDFDocumentProxy, index: number) {
  let pages = metadata.get(pdf);
  if (!pages) {
    pages = new Map();
    metadata.set(pdf, pages);
  }
  let promise = pages.get(index);
  if (promise) {
    pages.delete(index);
    pages.set(index, promise);
  }
  if (!promise) {
    promise = trackPerformance('pdf-images', () =>
      pdf.getPage(index + 1).then(async (p) => {
        const { OPS } = await import('pdfjs-dist');
        return imagePolygons(await p.getOperatorList(), OPS);
      }),
    );
    pages.set(index, promise);
    if (pages.size > 128) pages.delete(pages.keys().next().value!);
    promise.catch(() => pages!.delete(index));
  }
  return promise;
}
let worker: Worker | undefined,
  sequence = 0,
  idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<
  number,
  {
    resolve: (b: ImageBitmap) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function fail() {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('Night color worker unavailable'));
  }
  pending.clear();
  worker?.terminate();
  worker = undefined;
}
function getWorker() {
  clearTimeout(idle);
  if (!worker) {
    worker = new Worker(new URL('./pdfNight.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = fail;
    worker.onmessage = ({ data }) => {
      // Successful worker work is counted even if its consumer has gone away.
      // Only fixed backend labels are recorded; never pixels or PDF content.
      if (data.bitmap)
        performanceLedger?.count(
          data.backend === 'gpu' ? 'nightGpuConversions' : 'nightCpuConversions',
        );
      const p = pending.get(data.id);
      if (!p) {
        data.bitmap?.close();
        return;
      }
      pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.bitmap);
      if (!pending.size)
        idle = setTimeout(() => {
          worker?.terminate();
          worker = undefined;
        }, 60_000);
    };
  }
  return worker;
}
export async function applyPdfNight(
  canvas: HTMLCanvasElement,
  pdf: PDFDocumentProxy,
  index: number,
  transform: number[],
  opaque = false,
  maskFrame?: { width: number; height: number; x: number; y: number },
) {
  const images = await getPdfImages(pdf, index),
    bitmap = await createImageBitmap(canvas),
    w = getWorker(),
    id = ++sequence;
  try {
    const polygons = images
      .map((p) => transformPolygon(p, transform))
      .filter((p) => {
        const b = polygonBox(p);
        return (
          b.x < (maskFrame?.width ?? canvas.width) &&
          b.y < (maskFrame?.height ?? canvas.height) &&
          b.x + b.width > 0 &&
          b.y + b.height > 0
        );
      });
    const output = await new Promise<ImageBitmap>((resolve, reject) => {
      pending.set(id, { resolve, reject, timer: setTimeout(fail, 30_000) });
      w.postMessage({ id, bitmap, polygons, opaque, maskFrame }, [bitmap]);
    });
    canvas.getContext('2d')!.drawImage(output, 0, 0);
    output.close();
  } catch (error) {
    bitmap.close();
    throw error;
  }
}
