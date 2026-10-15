import type { PDFDocumentProxy, RenderOptions, RenderTask } from './pdfTypes';
import { PdfViewport } from './pdfViewport';
import type { PdfiumPageInfo } from './pdfiumProtocol';
import { renderPdfium } from './pdfiumRaster';
import { multiply, transformPolygon } from './pdfNightGeometry';

function inverse(m: number[]) {
  const [a, b, c, d, e, f] = m,
    det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
    throw new Error('Invalid PDF render transform');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
/** General affine rendering uses a clipped intermediate raster. Ordinary
 * viewport/tile rendering goes directly to PDFium with no extra surface. */
export function renderPdfiumPage(
  pdf: PDFDocumentProxy,
  page: number,
  info: PdfiumPageInfo,
  options: RenderOptions,
): RenderTask {
  let inner: RenderTask | undefined,
    cancelled = false;
  const task: RenderTask = {
    promise: Promise.resolve(),
    cancel: () => {
      cancelled = true;
      inner?.cancel();
    },
  };
  task.promise = (async () => {
    const canvas = options.canvas ?? options.canvasContext?.canvas;
    if (!canvas) throw new Error('PDF render canvas unavailable');
    const base = new PdfViewport(info, { scale: 1 });
    const matrix = multiply(
      options.transform ?? [1, 0, 0, 1, 0, 0],
      multiply(options.viewport.transform, inverse(base.transform)),
    );
    if (!matrix.every(Number.isFinite)) throw new Error('Invalid PDF render transform');
    const [a, b, c, d, e, f] = matrix;
    const direct =
      a > 0 &&
      Math.abs(b) < 1e-8 &&
      Math.abs(c) < 1e-8 &&
      Math.abs(a - d) < 1e-8 &&
      e <= 0 &&
      f <= 0;
    const ctx = options.canvasContext ?? canvas.getContext('2d')!;
    let scratch: HTMLCanvasElement | undefined;
    try {
      if (direct) {
        inner = renderPdfium(
          pdf,
          page,
          canvas,
          Math.ceil(base.width * a),
          Math.ceil(base.height * d),
          { x: Math.round(-e), y: Math.round(-f), width: canvas.width, height: canvas.height },
          options.widgets,
        );
      } else {
        const points = transformPolygon(
          [0, 0, canvas.width, 0, canvas.width, canvas.height, 0, canvas.height],
          inverse(matrix),
        );
        const xs = points.filter((_, i) => !(i % 2)),
          ys = points.filter((_, i) => i % 2);
        // Largest singular value prevents blur under skew/nonuniform scale.
        const q = a * a + b * b + c * c + d * d,
          det = a * d - b * c;
        const scale = Math.sqrt((q + Math.sqrt(Math.max(0, q * q - 4 * det * det))) / 2);
        const fullWidth = Math.ceil(base.width * scale),
          fullHeight = Math.ceil(base.height * scale);
        const x = Math.max(0, Math.floor(Math.min(...xs) * scale) - 2),
          y = Math.max(0, Math.floor(Math.min(...ys) * scale) - 2);
        const width = Math.min(fullWidth, Math.ceil(Math.max(...xs) * scale) + 2) - x,
          height = Math.min(fullHeight, Math.ceil(Math.max(...ys) * scale) + 2) - y;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = options.background ?? '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        if (width <= 0 || height <= 0) return;
        if (
          width * height > 32_000_000 ||
          Math.max(width, height) > 32767 ||
          Math.max(fullWidth, fullHeight) > 10_000_000
        )
          throw new Error('PDFium raster size limit');
        scratch = document.createElement('canvas');
        scratch.width = width;
        scratch.height = height;
        inner = renderPdfium(
          pdf,
          page,
          scratch,
          fullWidth,
          fullHeight,
          { x, y, width, height },
          options.widgets,
        );
        inner.onContinue = (resume) => (task.onContinue ? task.onContinue(resume) : resume());
        if (cancelled) inner.cancel();
        await inner.promise;
        if (cancelled)
          throw Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' });
        ctx.save();
        ctx.setTransform(
          a / scale,
          b / scale,
          c / scale,
          d / scale,
          e + (a * x + c * y) / scale,
          f + (b * x + d * y) / scale,
        );
        ctx.drawImage(scratch, 0, 0);
        ctx.restore();
        canvas.dataset.pdfBackend = 'pdfium';
        return;
      }
      inner.onContinue = (resume) => (task.onContinue ? task.onContinue(resume) : resume());
      if (cancelled) inner.cancel();
      await inner.promise;
    } finally {
      if (scratch) scratch.width = scratch.height = 1;
    }
  })();
  return task;
}
