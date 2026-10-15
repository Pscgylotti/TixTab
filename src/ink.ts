import { getStrokePoints, getStrokeOutlinePoints, type StrokeOptions } from 'perfect-freehand';
import type { Stroke } from './model';
import type { Bounds } from './spatialIndex';
import { stableInkSamples } from './inkSimplify';
import { inkCurve, smoothInkPath } from './inkCurve';
const paths = new WeakMap<Stroke, string>(),
  shapes = new WeakMap<Stroke, Path2D>(),
  bounds = new WeakMap<Stroke, Bounds>();
/** Reuse completed display geometry in an export worker without recomputing it
 * on the UI thread. Callers must only seed paths derived from the same stroke. */
export function cachedInkPath(stroke: Stroke) {
  return paths.get(stroke);
}
export function rememberInkPath(stroke: Stroke, path: string) {
  paths.set(stroke, path);
  shapes.delete(stroke);
  bounds.delete(stroke);
}
export function outline(stroke: Stroke) {
  let points: number[][] = stableInkSamples(stroke.points, stroke.size);
  // The library's one/two-point expansion loses pressure and adds a diagonal.
  // Expand after simplification, which can itself produce just two endpoints.
  if (points.length === 1) points = [points[0], points[0], points[0]];
  else if (points.length === 2) {
    const pair = points;
    points = Array.from({ length: 5 }, (_, i) =>
      pair[0].map((v, axis) => v + ((pair[1][axis] - v) * i) / 4),
    );
  }
  const options: StrokeOptions = {
    size: stroke.size,
    thinning:
      stroke.tool === 'ballpoint' || stroke.tool === 'highlighter'
        ? 0
        : stroke.tool === 'pencil'
          ? 0.65
          : 0.72,
    smoothing: 0.2,
    streamline: 0.25,
    simulatePressure: false,
    last: true,
  };
  // The brush width must not be used as a minimum initial travel distance:
  // otherwise an entire miniature U can disappear before the first kept point.
  const samples = getStrokePoints(points, { ...options, size: 0, last: true });
  const last = samples.at(-1);
  if (last && samples.length > 1) {
    // perfect-freehand 1.2.2 skips every non-final sample within 3 units of
    // the end. On a short fine stroke this includes its start, so its start
    // cap rotates the *end* outline around the start and makes a large disk.
    // The same absolute pruning can flatten a tiny curve at the end of a long
    // stroke. Disable it for all scales; causal brush-relative filtering controls noise.
    // No taper uses runningLength here; positions and pressure stay intact.
    last.runningLength += 3;
  }
  return getStrokeOutlinePoints(samples, options);
}
export function inkPath(stroke: Stroke) {
  return smoothInkPath(outline(stroke));
}
export function finalInkPath(stroke: Stroke) {
  let path = paths.get(stroke);
  if (path === undefined) {
    const points = outline(stroke);
    path = smoothInkPath(points);
    paths.set(stroke, path);
    bounds.set(stroke, geometryBounds(stroke, points));
  }
  return path;
}
function geometryBounds(stroke: Stroke, outline: readonly (readonly number[])[]): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (x: number, y: number, radius: number) => {
    minX = Math.min(minX, x - radius);
    minY = Math.min(minY, y - radius);
    maxX = Math.max(maxX, x + radius);
    maxY = Math.max(maxY, y + radius);
  };
  // Cover both exact rounded display geometry and the existing raw-point hit test.
  for (const p of outline) add(Number(p[0].toFixed(2)), Number(p[1].toFixed(2)), 0);
  for (const p of stroke.points) add(p[0], p[1], stroke.size / 2);
  return minX === Infinity ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX, minY, maxX, maxY };
}
export function inkBounds(stroke: Stroke): Bounds {
  finalInkPath(stroke);
  let box = bounds.get(stroke);
  if (!box) {
    // Worker/export seeded paths may intentionally have no raw points.
    const pairs = [...paths.get(stroke)!.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ]);
    box = geometryBounds(stroke, pairs);
    bounds.set(stroke, box);
  }
  return box;
}
/** Coarse render bounds can be built without preparing invisible perfect-freehand paths. */
export function cullingInkBounds(stroke: Stroke): Bounds {
  const exact = bounds.get(stroke);
  if (exact) return exact;
  // Imported/worker geometry may have no points, or legacy pressure outside [0,1].
  // Preserve that geometry rather than assuming the normal hardware radius limit.
  if (paths.has(stroke) || stroke.points.some((p) => p[2] < 0 || p[2] > 1))
    return inkBounds(stroke);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  // Includes pressure radius, caps and rounding, deliberately wider than exact display bounds.
  const pad = stroke.size * 2 + 2;
  return minX === Infinity
    ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    : { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, completed = false) {
  ctx.save();
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = stroke.tool === 'highlighter' ? 0.28 : stroke.tool === 'pencil' ? 0.65 : 1;
  let shape = completed ? shapes.get(stroke) : undefined;
  if (!shape) {
    if (completed) {
      shape = new Path2D(finalInkPath(stroke));
      shapes.set(stroke, shape);
    } else {
      // The live stroke is rebuilt every frame: add its outline directly, at the
      // committed path's two-decimal precision, without formatting and parsing text.
      shape = new Path2D();
      inkCurve(outline(stroke), shape);
    }
  }
  ctx.fill(shape);
  ctx.restore();
}
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[]) {
  for (const s of strokes) drawStroke(ctx, s, true);
}
