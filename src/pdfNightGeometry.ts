/** Image polygons in PDF coordinates. Stencil/image masks intentionally follow text colors.
 * Complex transparency/clipping and text painted over an image remain experimental. */
export type Matrix = number[];
export type ImagePolygon = number[];
export const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
export function transformPolygon(p: ImagePolygon, m: Matrix) {
  return p.map((_, i) =>
    i % 2 ? m[1] * p[i - 1] + m[3] * p[i] + m[5] : m[0] * p[i] + m[2] * p[i + 1] + m[4],
  );
}
export function polygonBox(p: ImagePolygon) {
  const xs = p.filter((_, i) => i % 2 === 0),
    ys = p.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
