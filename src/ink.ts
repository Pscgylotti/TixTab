import { getStroke } from 'perfect-freehand';
import type { Stroke } from './model';
const paths = new WeakMap<Stroke, string>(),
  shapes = new WeakMap<Stroke, Path2D>();
/** Reuse completed display geometry in an export worker without recomputing it
 * on the UI thread. Callers must only seed paths derived from the same stroke. */
export function cachedInkPath(stroke: Stroke) {
  return paths.get(stroke);
}
export function rememberInkPath(stroke: Stroke, path: string) {
  paths.set(stroke, path);
}
export function outline(stroke: Stroke) {
  // perfect-freehand interpolates two-point strokes without pressure. Preserve all
  // three coordinates ourselves so short pen flicks retain real hardware pressure.
  const points =
    stroke.points.length === 2
      ? Array.from({ length: 5 }, (_, i) =>
          stroke.points[0].map((v, axis) => v + ((stroke.points[1][axis] - v) * i) / 4),
        )
      : stroke.points;
  return getStroke(points, {
    size: stroke.size,
    thinning:
      stroke.tool === 'ballpoint' || stroke.tool === 'highlighter'
        ? 0
        : stroke.tool === 'pencil'
          ? 0.65
          : 0.72,
    smoothing: 0.5,
    streamline: 0.25,
    simulatePressure: false,
    last: true,
  });
}
export function inkPath(stroke: Stroke) {
  const points = outline(stroke);
  return points.length
    ? `M ${points.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' L ')} Z`
    : '';
}
export function finalInkPath(stroke: Stroke) {
  let path = paths.get(stroke);
  if (path === undefined) {
    path = inkPath(stroke);
    paths.set(stroke, path);
  }
  return path;
}
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, completed = false) {
  ctx.save();
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = stroke.tool === 'highlighter' ? 0.28 : stroke.tool === 'pencil' ? 0.65 : 1;
  let shape = completed ? shapes.get(stroke) : undefined;
  if (!shape) {
    shape = new Path2D(completed ? finalInkPath(stroke) : inkPath(stroke));
    if (completed) shapes.set(stroke, shape);
  }
  ctx.fill(shape);
  ctx.restore();
}
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  for (const s of strokes) drawStroke(ctx, s, true);
}
