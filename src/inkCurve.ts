const round = (n: number) => Number(n.toFixed(2));
/** Quadratic segments stay inside the outline's control hull (no overshoot).
 * Use identical rounded controls for live canvas, saved SVG and PDF export. */
export function inkCurve(
  points: readonly number[][],
  target: {
    moveTo(x: number, y: number): void;
    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
    closePath(): void;
  },
) {
  if (!points.length) return;
  const rounded = points.map(([x, y]) => [round(x), round(y)]);
  const midpoint = (a: number[], b: number[]) => [
    round((a[0] + b[0]) / 2),
    round((a[1] + b[1]) / 2),
  ];
  const start = midpoint(rounded.at(-1)!, rounded[0]);
  target.moveTo(start[0], start[1]);
  for (let i = 0; i < rounded.length; i++) {
    const p = rounded[i],
      end = midpoint(p, rounded[(i + 1) % rounded.length]);
    target.quadraticCurveTo(p[0], p[1], end[0], end[1]);
  }
  target.closePath();
}
export function smoothInkPath(points: readonly number[][]) {
  const path: string[] = [];
  inkCurve(points, {
    moveTo: (x, y) => path.push(`M ${x},${y}`),
    quadraticCurveTo: (cx, cy, x, y) => path.push(`Q ${cx},${cy} ${x},${y}`),
    closePath: () => path.push('Z'),
  });
  return path.join(' ');
}
