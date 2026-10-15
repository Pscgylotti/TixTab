import type { Stroke } from './model';
import { drawStroke, drawStrokes, inkBounds } from './ink';
import { SpatialIndex, unionBounds, type Bounds } from './spatialIndex';
import { renderPolicy } from './appearance';

export function committedInkRatio(page: { width: number; height: number }) {
  const minimal = renderPolicy().minimal;
  return Math.min(
    minimal ? 1 : 2,
    Math.sqrt((minimal ? 1000000 : 4000000) / (page.width * page.height)),
  );
}

/** Retain the exact raster; a dynamic bounds hierarchy selects ordered survivors
 * for dirty-region replay. Reordering and large changes still replay the layer. */
export class CommittedInk {
  readonly index = new SpatialIndex<Stroke>(inkBounds);
  private scratch?: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
  private previous?: {
    canvas: HTMLCanvasElement;
    pageId: string;
    width: number;
    height: number;
    pixelsWide: number;
    pixelsHigh: number;
    strokes: readonly Stroke[];
  };

  reset() {
    this.previous = undefined;
    this.releaseScratch();
  }

  private releaseScratch() {
    if (this.scratch) {
      this.scratch.canvas.width = this.scratch.canvas.height = 0;
      this.scratch = undefined;
    }
  }

  candidates(strokes: readonly Stroke[], box: Bounds) {
    this.index.update(strokes);
    return this.index.search(box, false);
  }

  paint(
    canvas: HTMLCanvasElement,
    page: { id: string; width: number; height: number; strokes: readonly Stroke[] },
  ) {
    if (renderPolicy().minimal && !page.strokes.length) {
      this.reset();
      canvas.width = canvas.height = 1;
      return { mode: 'full' as const, usedScratch: false, strokesDrawn: 0, pixelsCleared: 1 };
    }
    const ratio = committedInkRatio(page),
      width = Math.ceil(page.width * ratio),
      height = Math.ceil(page.height * ratio),
      previous = this.previous;
    const retained =
      !!previous &&
      previous.canvas === canvas &&
      previous.pageId === page.id &&
      previous.width === page.width &&
      previous.height === page.height &&
      previous.pixelsWide === canvas.width &&
      previous.pixelsHigh === canvas.height &&
      canvas.width === width &&
      canvas.height === height;
    let append = retained && previous!.strokes.length <= page.strokes.length;
    if (append && previous!.strokes !== page.strokes)
      for (let i = 0; i < previous!.strokes.length; i++)
        if (previous!.strokes[i] !== page.strokes[i]) {
          append = false;
          break;
        }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.reset();
      return;
    }
    // Input events can advance the hit-test tree before React commits a raster.
    // Such an intermediate edit must not be omitted from this paint's damage.
    const changesFromRaster = this.index.matches(previous?.strokes);
    const changes = this.index.update(page.strokes);
    if (!retained) this.releaseScratch();
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    let mode: 'append' | 'dirty' | 'full' = append ? 'append' : 'full';
    let repaint: Stroke[] | undefined;
    let rect: { x: number; y: number; width: number; height: number } | undefined;
    let completePaths = false;
    const scale = width / page.width;
    if (retained && !append && changesFromRaster && !changes.reordered) {
      const box = unionBounds([...changes.removed, ...changes.added]);
      if (box) {
        // Clipping through a transparent path changes Skia's tessellation even
        // at integer pixels. Draw complete paths on a same-size scratch canvas
        // and copy just the damage. Its original transform preserves AA exactly.
        const pixels = (b: Bounds) => ({
          minX: Math.max(0, Math.min(width, Math.floor(b.minX * scale) - 2)),
          minY: Math.max(0, Math.min(height, Math.floor(b.minY * scale) - 2)),
          maxX: Math.max(0, Math.min(width, Math.ceil(b.maxX * scale) + 2)),
          maxY: Math.max(0, Math.min(height, Math.ceil(b.maxY * scale) + 2)),
        });
        const region = pixels(box);
        if ((region.maxX - region.minX) * (region.maxY - region.minY) < width * height * 0.5) {
          repaint = this.index.search({
            minX: (region.minX - 2) / scale,
            minY: (region.minY - 2) / scale,
            maxX: (region.maxX + 2) / scale,
            maxY: (region.maxY + 2) / scale,
          });
          if (repaint.length < page.strokes.length * 0.7 || !page.strokes.length) {
            rect = {
              x: region.minX,
              y: region.minY,
              width: region.maxX - region.minX,
              height: region.maxY - region.minY,
            };
            mode = 'dirty';
            completePaths = repaint.every((s) => {
              const b = pixels(inkBounds(s));
              return (
                b.minX >= region.minX &&
                b.minY >= region.minY &&
                b.maxX <= region.maxX &&
                b.maxY <= region.maxY
              );
            });
          }
        }
      }
    }
    let usedScratch = false;
    if (mode === 'dirty' && !completePaths && rect!.width && rect!.height) {
      if (!this.scratch) {
        const buffer = canvas.ownerDocument.createElement('canvas');
        buffer.width = width;
        buffer.height = height;
        const bufferContext = buffer.getContext('2d', {
          willReadFrequently: ctx.getContextAttributes().willReadFrequently,
        });
        if (bufferContext) this.scratch = { canvas: buffer, ctx: bufferContext };
      }
      const scratch = this.scratch;
      if (!scratch || scratch.ctx.isContextLost()) {
        this.releaseScratch();
        mode = 'full';
      } else {
        scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
        scratch.ctx.clearRect(rect!.x, rect!.y, rect!.width, rect!.height);
        scratch.ctx.setTransform(scale, 0, 0, scale, 0, 0);
        drawStrokes(scratch.ctx, repaint!);
        if (scratch.ctx.isContextLost()) {
          this.releaseScratch();
          mode = 'full';
        } else usedScratch = true;
      }
    }
    if (mode === 'dirty') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(rect!.x, rect!.y, rect!.width, rect!.height);
      if (usedScratch)
        ctx.drawImage(
          this.scratch!.canvas,
          rect!.x,
          rect!.y,
          rect!.width,
          rect!.height,
          rect!.x,
          rect!.y,
          rect!.width,
          rect!.height,
        );
      else {
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        drawStrokes(ctx, repaint!);
      }
    } else if (mode === 'full') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawStrokes(ctx, page.strokes);
    } else {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      for (let i = previous!.strokes.length; i < page.strokes.length; i++)
        drawStroke(ctx, page.strokes[i], true);
    }
    this.previous = {
      canvas,
      pageId: page.id,
      width: page.width,
      height: page.height,
      pixelsWide: width,
      pixelsHigh: height,
      strokes: page.strokes,
    };
    if (renderPolicy().minimal) this.releaseScratch();
    return {
      mode,
      usedScratch,
      strokesDrawn:
        mode === 'dirty'
          ? repaint!.length
          : mode === 'append'
            ? page.strokes.length - previous!.strokes.length
            : page.strokes.length,
      pixelsCleared:
        mode === 'dirty' ? rect!.width * rect!.height : mode === 'full' ? width * height : 0,
    };
  }
}
