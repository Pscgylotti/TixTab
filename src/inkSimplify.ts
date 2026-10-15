import type { Point } from './model';
/** Causal, brush-relative noise rejection. Appending samples never refits the
 * already accepted trajectory. Raw hardware samples are saved unchanged. */
export function stableInkSamples(points: Point[], size: number): Point[] {
  if (points.length < 3) return points;
  const accepted = [points[0]],
    distance = Math.max(0, size) * 0.025;
  for (let i = 1; i < points.length; i++) {
    const p = points[i],
      previous = accepted.at(-1)!;
    if (
      Math.hypot(p[0] - previous[0], p[1] - previous[1]) >= distance ||
      Math.abs(p[2] - previous[2]) >= 0.05
    )
      accepted.push(p);
  }
  // Only the tip is provisional. Do not drop the final sub-step of a fine turn.
  if (accepted.at(-1) !== points.at(-1)) accepted.push(points.at(-1)!);
  return accepted;
}
