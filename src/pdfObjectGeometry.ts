/** Affine matrices as [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = number[];
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** Apply q first, then p. */
export function multiply(p: Affine, q: Affine): Affine {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}
export function invert(m: Affine): Affine {
  const [a, b, c, d, e, f] = m,
    det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('invalid-transform');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
export const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
export function scaleAbout(sx: number, sy: number, x: number, y: number): Affine {
  return [sx, 0, 0, sy, x - sx * x, y - sy * y];
}
/** Clockwise on screen, where y grows downward. */
export function rotateAbout(radians: number, x: number, y: number): Affine {
  const cos = Math.cos(radians),
    sin = Math.sin(radians);
  return multiply(translate(x, y), multiply([cos, sin, -sin, cos, 0, 0], translate(-x, -y)));
}
export function apply(m: Affine, x: number, y: number) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function applyPolygon(m: Affine, points: number[]) {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) out.push(...apply(m, points[i], points[i + 1]));
  return out;
}
/** left, top, right, bottom */
export function polygonBox(points: number[]) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    x0 = Math.min(x0, points[i]);
    x1 = Math.max(x1, points[i]);
    y0 = Math.min(y0, points[i + 1]);
    y1 = Math.max(y1, points[i + 1]);
  }
  return [x0, y0, x1, y1];
}
export function unionBox(boxes: number[][]) {
  return boxes.reduce(
    (u, b) => [
      Math.min(u[0], b[0]),
      Math.min(u[1], b[1]),
      Math.max(u[2], b[2]),
      Math.max(u[3], b[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}
export function containsPoint(points: number[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i],
      yi = points[i + 1],
      xj = points[j],
      yj = points[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** A change drawn in page coordinates, expressed in PDF user space. `view`
 * maps PDF user space to page coordinates (the page viewport transform). */
export function toPdfSpace(change: Affine, view: Affine): Affine {
  return multiply(invert(view), multiply(change, view));
}
export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
/** Translation per box that aligns it with the union of all boxes. */
export function alignOffsets(boxes: number[][], alignment: Alignment) {
  const u = unionBox(boxes);
  return boxes.map((b) => {
    switch (alignment) {
      case 'left':
        return [u[0] - b[0], 0];
      case 'right':
        return [u[2] - b[2], 0];
      case 'center':
        return [(u[0] + u[2]) / 2 - (b[0] + b[2]) / 2, 0];
      case 'top':
        return [0, u[1] - b[1]];
      case 'bottom':
        return [0, u[3] - b[3]];
      case 'middle':
        return [0, (u[1] + u[3]) / 2 - (b[1] + b[3]) / 2];
    }
  });
}
/** Equal gaps between boxes along one axis, keeping the outermost two in place. */
export function distributeOffsets(boxes: number[][], axis: 'x' | 'y') {
  const [lo, hi] = axis === 'x' ? [0, 2] : [1, 3],
    order = boxes.map((_, i) => i).sort((i, j) => boxes[i][lo] - boxes[j][lo]),
    offsets = boxes.map(() => [0, 0]);
  if (boxes.length < 3) return offsets;
  const span = boxes[order.at(-1)!][hi] - boxes[order[0]][lo],
    used = boxes.reduce((sum, b) => sum + b[hi] - b[lo], 0),
    gap = (span - used) / (boxes.length - 1);
  let cursor = boxes[order[0]][hi] + gap;
  for (const i of order.slice(1, -1)) {
    offsets[i][axis === 'x' ? 0 : 1] = cursor - boxes[i][lo];
    cursor += boxes[i][hi] - boxes[i][lo] + gap;
  }
  return offsets;
}
