import { drawStroke, drawStrokes } from './ink';
import type { Stroke } from './model';

/** Keep the formula recognizer's exact 960px white raster, appending immutable strokes. */
export class FormulaInk {
  private previous?: { canvas: HTMLCanvasElement; height: number; strokes: readonly Stroke[] };

  reset() {
    this.previous = undefined;
  }

  paint(canvas: HTMLCanvasElement, strokes: readonly Stroke[], height: number) {
    const previous = this.previous;
    let append =
      !!previous &&
      previous.canvas === canvas &&
      previous.height === height &&
      canvas.width === 960 &&
      canvas.height === height &&
      previous.strokes.length <= strokes.length;
    if (append)
      for (let i = 0; i < previous!.strokes.length; i++)
        if (previous!.strokes[i] !== strokes[i]) {
          append = false;
          break;
        }
    const ctx = canvas.getContext('2d');
    if (!ctx || ctx.isContextLost()) {
      this.reset();
      return;
    }
    if (append) {
      for (let i = previous!.strokes.length; i < strokes.length; i++)
        drawStroke(ctx, strokes[i], true);
    } else {
      // A removal, restored draft, changed geometry/order/size or replaced canvas replays fully.
      canvas.width = 960;
      canvas.height = height;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 960, height);
      drawStrokes(ctx, strokes);
    }
    this.previous = { canvas, height, strokes };
    return {
      mode: append ? 'append' : 'full',
      strokesDrawn: append ? strokes.length - previous!.strokes.length : strokes.length,
    };
  }
}
