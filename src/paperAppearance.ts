import type { CSSProperties } from 'react';
import type { Page } from './model';
import { transformNightPixels } from './pdfNightColors';
export const paperChoices = [
  { id: 'plain', label: '空白' },
  { id: 'dots', label: '点阵' },
  { id: 'grid', label: '格子' },
  { id: 'lines', label: '横线' },
  { id: 'fine-grid', label: '细密格子' },
] as const;
export const paperStep = (paper: Page['paper']) =>
  paper === 'fine-grid' ? 10 : paper === 'grid' ? 20 : paper === 'lines' ? 28 : 16;
export function paperAppearance(
  page: Pick<Page, 'paper' | 'paperColor' | 'width' | 'height'>,
  night = false,
): CSSProperties {
  const color = page.paperColor ?? '#ffffff';
  const rgba = Uint8ClampedArray.from([
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
    255,
  ]);
  if (night) transformNightPixels(rgba);
  const line = night ? '#556075' : '#aebdd35c',
    step = paperStep(page.paper),
    grid = page.paper === 'grid' || page.paper === 'fine-grid';
  return {
    backgroundColor: `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`,
    backgroundImage:
      page.paper === 'plain'
        ? 'none'
        : page.paper === 'dots'
          ? `radial-gradient(${line} 0.65px, transparent 0.75px)`
          : grid
            ? `linear-gradient(to right, ${line} .6px, transparent .6px),linear-gradient(to bottom, ${line} .6px, transparent .6px)`
            : `linear-gradient(to bottom,transparent calc(100% - .6px),${line} .6px)`,
    backgroundSize:
      page.paper === 'lines'
        ? `100% ${(step / page.height) * 100}%`
        : `${(step / page.width) * 100}% ${(step / page.height) * 100}%`,
  };
}
export function drawPaperPattern(
  ctx: CanvasRenderingContext2D,
  page: Page,
  region: { x: number; y: number; width: number; height: number },
) {
  if (page.paper === 'plain') return;
  const step = paperStep(page.paper),
    x0 = Math.max(0, Math.floor(region.x / step) * step),
    y0 = Math.max(0, Math.floor(region.y / step) * step),
    right = Math.min(page.width, region.x + region.width),
    bottom = Math.min(page.height, region.y + region.height);
  ctx.strokeStyle = '#aebdd35c';
  ctx.fillStyle = '#aebdd35c';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  if (page.paper === 'dots') {
    for (let y = y0 + step / 2; y < bottom; y += step)
      for (let x = x0 + step / 2; x < right; x += step) {
        ctx.moveTo(x + 0.65, y);
        ctx.arc(x, y, 0.65, 0, Math.PI * 2);
      }
    ctx.fill();
    return;
  }
  for (let y = y0; y <= bottom; y += step) {
    ctx.moveTo(region.x, y);
    ctx.lineTo(right, y);
  }
  if (page.paper === 'grid' || page.paper === 'fine-grid')
    for (let x = x0; x <= right; x += step) {
      ctx.moveTo(x, region.y);
      ctx.lineTo(x, bottom);
    }
  ctx.stroke();
}
