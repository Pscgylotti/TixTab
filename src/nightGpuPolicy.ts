import type { ImagePolygon } from './pdfNightGeometry';

/** A single convex picture must contain the complete raster, including its
 * outer pixel edges. Partial/union coverage stays on the exact CPU path. */
export function fullyCoveredByBitmap(width: number, height: number, polygons: ImagePolygon[]) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    return false;
  const containsRaster = (p: ImagePolygon) => {
    if (p.length !== 8 || p.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e9)) return false;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4,
        k = (i + 2) % 4;
      const cross =
        (p[j * 2] - p[i * 2]) * (p[k * 2 + 1] - p[j * 2 + 1]) -
        (p[j * 2 + 1] - p[i * 2 + 1]) * (p[k * 2] - p[j * 2]);
      if (!cross || (sign && Math.sign(cross) !== sign)) return false;
      sign = Math.sign(cross);
    }
    return [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ].every(([x, y]) => {
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const cross =
          (p[j * 2] - p[i * 2]) * (y - p[i * 2 + 1]) -
          (p[j * 2 + 1] - p[i * 2 + 1]) * (x - p[i * 2]);
        if (cross * sign < 0) return false;
      }
      return true;
    });
  };
  // Canvas paths may store vertices at float32 precision. Require containment
  // both before and after that conversion; large rotated coordinates can move
  // a nominally covered corner inward by a pixel.
  return polygons.some(
    (p) => containsRaster(p) && containsRaster(p.map(Math.fround) as ImagePolygon),
  );
}

/** Upload the exact Uint8ClampedArray result of the existing bitmap policy.
 * A tiny lookup avoids GPU float/byte rounding and retains all 256 levels. */
export function bitmapDimmingCurve() {
  const values = new Uint8ClampedArray(256);
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    values[i] = i * 0.62;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = values[i];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
