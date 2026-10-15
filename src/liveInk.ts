import type { Stroke } from './model';
import { cullingInkBounds, drawStroke } from './ink';
import { unionBounds } from './spatialIndex';

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

/** A transient, screen-density raster of only the visible active ink. Never
 * allocate a zoomed whole-page bitmap (large/oversized PDFs can be enormous). */
export function paintLiveInk(
  canvas: HTMLCanvasElement,
  page: { width: number; height: number },
  strokes: readonly Stroke[],
  paper: Rect,
  viewport: Rect,
  dpr: number,
) {
  const box = unionBounds(strokes.map(cullingInkBounds));
  const sx = paper.width / page.width,
    sy = paper.height / page.height;
  if (!box || !(sx > 0 && sy > 0)) return releaseLiveInk(canvas);
  const left = Math.max(0, box.minX, (viewport.left - paper.left) / sx),
    top = Math.max(0, box.minY, (viewport.top - paper.top) / sy),
    right = Math.min(page.width, box.maxX, (viewport.right - paper.left) / sx),
    bottom = Math.min(page.height, box.maxY, (viewport.bottom - paper.top) / sy);
  if (right <= left || bottom <= top) return releaseLiveInk(canvas);

  // Align backing pixels and grow in small buckets to avoid reallocating on
  // every sample. Current browser/Electron zoom is included in rects and DPR.
  const density = Math.max(1, Number.isFinite(dpr) ? dpr : 1);
  const dx = sx * density,
    dy = sy * density;
  const x = (Math.floor((left * dx) / 64) * 64) / dx,
    y = (Math.floor((top * dy) / 64) * 64) / dy;
  const w = Math.ceil(((right - x) * dx) / 64) * 64,
    h = Math.ceil(((bottom - y) * dy) / 64) * 64;
  // An abnormal monitor/DPR cannot allocate an unbounded texture. The normal
  // case uses one backing pixel per physical display pixel, in every memory mode.
  const limit = Math.min(1, 8192 / w, 8192 / h, Math.sqrt(16_000_000 / (w * h)));
  const width = Math.max(1, Math.floor(w * limit)),
    height = Math.max(1, Math.floor(h * limit));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.style.left = `${x}px`;
  canvas.style.top = `${y}px`;
  canvas.style.width = `${w / dx}px`;
  canvas.style.height = `${h / dy}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const rx = width / (w / dx),
    ry = height / (h / dy);
  ctx.setTransform(rx, 0, 0, ry, -x * rx, -y * ry);
  for (const stroke of strokes) drawStroke(ctx, stroke);
}

/** All modes release the high-density working buffer as soon as contact ends. */
export function releaseLiveInk(canvas: HTMLCanvasElement) {
  if (canvas.width !== 1 || canvas.height !== 1) canvas.width = canvas.height = 1;
  canvas.style.width = canvas.style.height = '1px';
}
