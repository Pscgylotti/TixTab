import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Page } from './model';
import { drawStrokes } from './ink';
import { pageLayers } from './pageLayers';
import { recognitionImageSize } from './recognitionImageSize';
import { groupLeaves } from './objectGroup';
import { drawPlacedImage } from './objectRotation';
import { drawPaperPattern } from './paperAppearance';
export interface PageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export async function capturePage(page: Page, pdf: PDFDocumentProxy | null, region: PageRegion) {
  const { width, height, scale } = recognitionImageSize(region.width, region.height, 2.5),
    c = document.createElement('canvas');
  c.width = width;
  c.height = height;
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
  }
  ctx.setTransform(scale, 0, 0, scale, -region.x * scale, -region.y * scale);
  if (page.sourceIndex === null) drawPaperPattern(ctx, page, region);
  for (const image of pageLayers(page).flatMap((i) => (i ? groupLeaves(i) : [i]))) {
    if (!image) {
      drawStrokes(ctx, page.strokes);
      continue;
    }
    const i = new Image();
    i.src = image.displayData ?? image.data;
    await i.decode();
    drawPlacedImage(ctx, i, image);
  }
  return c.toDataURL('image/png');
}
