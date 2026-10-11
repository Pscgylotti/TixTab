import type { PdfPixelRegion } from './pdfRenderCache';
export interface LogicalRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const TILE_SIZE = 512,
  MAX_TILE_PIXELS = 12_000_000;
export interface TilePlan {
  scale: number;
  tiles: PdfPixelRegion[];
  pixels: number;
}
/** Grid is anchored to the page, so panning reuses overlapping tiles. */
export function planPdfTiles(
  width: number,
  height: number,
  area: LogicalRegion,
  requestedScale: number,
  pixelBudget = 6_000_000,
): TilePlan {
  const budget = Math.max(TILE_SIZE * TILE_SIZE, Math.min(MAX_TILE_PIXELS, pixelBudget));
  if (
    ![width, height, area.x, area.y, area.width, area.height, requestedScale].every(
      Number.isFinite,
    ) ||
    width <= 0 ||
    height <= 0 ||
    requestedScale <= 0 ||
    area.width <= 0 ||
    area.height <= 0
  )
    return { scale: 1, tiles: [], pixels: 0 };
  const left = Math.max(0, area.x),
    top = Math.max(0, area.y),
    right = Math.min(width, area.x + area.width),
    bottom = Math.min(height, area.y + area.height);
  let scale = Math.max(0.125, Math.floor(Math.min(8, requestedScale) * 8) / 8);
  if (right <= left || bottom <= top) return { scale, tiles: [], pixels: 0 };
  for (;;) {
    const pixelWidth = Math.ceil(width * scale),
      pixelHeight = Math.ceil(height * scale),
      tiles: PdfPixelRegion[] = [];
    // Budget the worst grid alignment, so small pans do not change resolution
    // and invalidate every cached tile at the pixel-budget boundary.
    const columns = Math.min(
      Math.ceil(pixelWidth / TILE_SIZE),
      Math.ceil(((right - left) * scale + 96) / TILE_SIZE) + 1,
    );
    const rows = Math.min(
      Math.ceil(pixelHeight / TILE_SIZE),
      Math.ceil(((bottom - top) * scale + 96) / TILE_SIZE) + 1,
    );
    const worstPixels =
      Math.min(pixelWidth, columns * TILE_SIZE) * Math.min(pixelHeight, rows * TILE_SIZE);
    if (worstPixels > budget && scale > 0.125) {
      scale = Math.max(0.125, Math.floor(scale * Math.sqrt(budget / worstPixels) * 0.9 * 8) / 8);
      continue;
    }
    // A small pixel margin makes short pans reuse the current detail layer.
    const x1 = Math.max(0, Math.floor((left * scale - 48) / TILE_SIZE)),
      y1 = Math.max(0, Math.floor((top * scale - 48) / TILE_SIZE));
    const x2 = Math.min(
        Math.ceil(pixelWidth / TILE_SIZE),
        Math.ceil((right * scale + 48) / TILE_SIZE),
      ),
      y2 = Math.min(
        Math.ceil(pixelHeight / TILE_SIZE),
        Math.ceil((bottom * scale + 48) / TILE_SIZE),
      );
    // Avoid allocating huge candidate arrays for unusual PDFs or viewports.
    if ((x2 - x1) * (y2 - y1) > 64) {
      if (scale <= 0.125) return { scale, tiles: [], pixels: 0 };
      scale = Math.max(0.125, Math.floor(scale * 0.75 * 8) / 8);
      continue;
    }
    let pixels = 0;
    for (let y = y1; y < y2; y++)
      for (let x = x1; x < x2; x++) {
        const tile = {
          x: x * TILE_SIZE,
          y: y * TILE_SIZE,
          width: Math.min(TILE_SIZE, pixelWidth - x * TILE_SIZE),
          height: Math.min(TILE_SIZE, pixelHeight - y * TILE_SIZE),
        };
        tiles.push(tile);
        pixels += tile.width * tile.height;
      }
    if (pixels > budget && scale > 0.125) {
      scale = Math.max(0.125, Math.floor(scale * Math.sqrt(budget / pixels) * 0.9 * 8) / 8);
      continue;
    }
    if (pixels > budget) return { scale, tiles: [], pixels: 0 };
    const cx = ((left + right) / 2) * scale,
      cy = ((top + bottom) / 2) * scale;
    tiles.sort(
      (a, b) =>
        Math.hypot(a.x + a.width / 2 - cx, a.y + a.height / 2 - cy) -
        Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy),
    );
    return { scale, tiles, pixels };
  }
}
