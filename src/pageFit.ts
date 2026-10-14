export const MIN_ZOOM = 0.01,
  MAX_ZOOM = 32,
  PAGE_EDGE = 8;
export type PageSize = { width: number; height: number };
export type FitControl = { left: number; right: number; top: number; bottom: number };
/** Width fitting permits vertical scrolling/panning. Continuous layouts use
 * the widest page so a wider sheet cannot create horizontal overflow. */
export function fitWidthZoom(
  pages: PageSize[],
  index: number,
  mode: 'single' | 'continuous' | 'dual',
  width: number,
) {
  const spread =
    mode === 'continuous' ? pages : pages.slice(index, index + (mode === 'dual' ? 2 : 1));
  if (!spread.length || width <= 0) return 1;
  const paperWidth =
      mode === 'continuous'
        ? Math.max(...spread.map((p) => p.width))
        : spread.reduce((sum, p) => sum + p.width, 0),
    gap = mode === 'dual' && spread.length === 2 ? 16 : 0;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (width - PAGE_EDGE * 2 - gap) / paperWidth));
}
/** PDF sizes already include the visible crop box and rotation. Never crop content. */
export function fitPageZoom(
  pages: PageSize[],
  index: number,
  mode: 'single' | 'continuous' | 'dual',
  width: number,
  height: number,
) {
  const spread = pages.slice(index, index + (mode === 'dual' ? 2 : 1));
  if (!spread.length || width <= 0 || height <= 0) return 1;
  const paperWidth = spread.reduce((sum, p) => sum + p.width, 0),
    paperHeight = Math.max(...spread.map((p) => p.height));
  const heading = mode === 'single' ? 0 : mode === 'continuous' ? 25 : 36,
    gap = spread.length === 2 ? 16 : 0;
  return Math.max(
    MIN_ZOOM,
    Math.min(
      MAX_ZOOM,
      (width - PAGE_EDGE * 2 - gap) / paperWidth,
      (height - PAGE_EDGE * 2 - heading) / paperHeight,
    ),
  );
}
/** Use transparent space beside controls; reserve only controls the paper intersects. */
export function fitPageWithControls(
  pages: PageSize[],
  index: number,
  mode: 'single' | 'continuous' | 'dual',
  width: number,
  height: number,
  controls: FitControl[],
) {
  const spread = pages.slice(index, index + (mode === 'dual' ? 2 : 1));
  let best = { zoom: MIN_ZOOM, inset: 0 };
  const heading = mode === 'single' ? 0 : mode === 'continuous' ? 25 : 36,
    gap = spread.length === 2 ? 16 : 0;
  for (const usable of [height, ...controls.map((c) => Math.max(1, c.top - PAGE_EDGE))].sort(
    (a, b) => b - a,
  )) {
    const zoom = fitPageZoom(pages, index, mode, width, usable),
      paperWidth = spread.reduce((n, p) => n + p.width * zoom, 0) + gap;
    let x = (width - paperWidth) / 2;
    const collision = spread.some((p) => {
      const top = mode === 'single' ? (usable - p.height * zoom) / 2 : PAGE_EDGE + heading;
      const rect = { left: x, right: x + p.width * zoom, top, bottom: top + p.height * zoom };
      x = rect.right + gap;
      return controls.some(
        (c) =>
          rect.left < c.right + PAGE_EDGE &&
          rect.right > c.left - PAGE_EDGE &&
          rect.top < c.bottom + PAGE_EDGE &&
          rect.bottom > c.top - PAGE_EDGE,
      );
    });
    if (!collision && zoom > best.zoom) best = { zoom, inset: height - usable };
  }
  return best;
}
