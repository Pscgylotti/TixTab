import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Page } from './model';
import { drawStrokes } from './ink';
export interface PageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export async function capturePage(page: Page, pdf: PDFDocumentProxy | null, region: PageRegion) {
  const scale = Math.min(2.5, Math.sqrt(4_000_000 / (region.width * region.height))),
    c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(region.width * scale));
  c.height = Math.max(1, Math.ceil(region.height * scale));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
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
  for (const image of page.images) {
    const i = new Image();
    i.src = image.displayData ?? image.data;
    await i.decode();
    ctx.drawImage(i, image.x, image.y, image.width, image.height);
  }
  drawStrokes(ctx, page.strokes);
  return c.toDataURL('image/png');
}
