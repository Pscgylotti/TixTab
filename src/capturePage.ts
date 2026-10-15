import type { PDFDocumentProxy } from './pdfTypes';
import { isPicture, type Page } from './model';
import { drawStrokes, cullingInkBounds } from './ink';
import { pageLayers } from './pageLayers';
import { recognitionImageSize } from './recognitionImageSize';
import { groupLeaves } from './objectGroup';
import { drawPlacedImage } from './objectRotation';
import { applyPdfNight, applyNightPolygons } from './pdfNight';
import { drawPaperPattern } from './paperAppearance';
export interface PageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export async function capturePage(
  page: Page,
  pdf: PDFDocumentProxy | null,
  region: PageRegion,
  options: { scale?: number; night?: boolean; ink?: boolean } = {},
) {
  const { width, height, scale } = recognitionImageSize(
      region.width,
      region.height,
      options.scale ?? 2.5,
    ),
    c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  try {
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = page.sourceIndex === null ? (page.paperColor ?? '#fff') : '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (pdf && page.sourceIndex !== null) {
      const p = await pdf.getPage(page.sourceIndex + 1);
      await p.render({
        canvas: c,
        viewport: p.getViewport({ scale }),
        transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale],
      }).promise;
      if (options.night) {
        const transform = [...p.getViewport({ scale }).transform];
        transform[4] -= region.x * scale;
        transform[5] -= region.y * scale;
        await applyPdfNight(c, pdf, page.sourceIndex, transform, true);
      }
    } else if (options.night) {
      await applyNightPolygons(c, [], true);
    }
    ctx.setTransform(scale, 0, 0, scale, -region.x * scale, -region.y * scale);
    if (page.sourceIndex === null) drawPaperPattern(ctx, page, region);
    for (const image of pageLayers(page).flatMap((i) => (i ? groupLeaves(i) : [i]))) {
      if (!image) {
        if (options.ink === false) continue;
        ctx.filter = options.night ? 'invert(0.9) hue-rotate(180deg)' : 'none';
        drawStrokes(
          ctx,
          page.strokes.filter((stroke) => {
            const b = cullingInkBounds(stroke);
            return (
              b.maxX >= region.x &&
              b.minX <= region.x + region.width &&
              b.maxY >= region.y &&
              b.minY <= region.y + region.height
            );
          }),
        );
        ctx.filter = 'none';
        continue;
      }
      if (
        image.x + image.width < region.x ||
        image.x > region.x + region.width ||
        image.y + image.height < region.y ||
        image.y > region.y + region.height
      )
        continue;
      const i = new Image();
      i.src =
        options.night && image.scratchPage && image.nightData
          ? image.nightData
          : (image.displayData ?? image.data);
      await i.decode();
      ctx.filter = options.night
        ? isPicture(image)
          ? image.scratchPage && image.nightData
            ? 'none'
            : 'brightness(0.62)'
          : 'invert(0.9) hue-rotate(180deg)'
        : 'none';
      drawPlacedImage(ctx, i, image);
      ctx.filter = 'none';
    }
    return c.toDataURL('image/png');
  } finally {
    c.width = c.height = 1;
  }
}
