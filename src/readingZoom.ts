import type { Page } from './model';
import { itemAt, makeLayout } from './virtualLayout';
/** Page headings, padding and gaps stay in CSS pixels while paper scales. */
export function zoomReadingPoint(
  pages: Pick<Page, 'width' | 'height'>[],
  mode: 'continuous' | 'dual',
  index: number,
  viewportWidth: number,
  from: number,
  to: number,
  point: { x: number; y: number },
  seamless = false,
) {
  const ratio = to / from;
  if (mode === 'continuous') {
    const heading = seamless ? 0 : 25,
      inset = seamless ? 0 : 8;
    const oldLayout = makeLayout(
        pages.map((p) => p.height * from + heading),
        inset,
      ),
      newLayout = makeLayout(
        pages.map((p) => p.height * to + heading),
        inset,
      );
    const i = itemAt(oldLayout, point.y - inset),
      local = point.y - inset - oldLayout.offsets[i];
    const widest = pages.reduce((w, p) => Math.max(w, p.width), 0),
      oldWidth = Math.max(viewportWidth, widest * from + 16),
      newWidth = Math.max(viewportWidth, widest * to + 16);
    return {
      x: newWidth / 2 + (point.x - oldWidth / 2) * ratio,
      y:
        point.y < inset
          ? point.y
          : inset +
            newLayout.offsets[i] +
            (local <= heading ? local : heading + (local - heading) * ratio),
    };
  }
  const spread = pages.slice(index, index + 2),
    logicalWidth = spread.reduce((w, p) => w + p.width, 0),
    gap = spread.length === 2 ? 16 : 0;
  const oldWidth = Math.max(viewportWidth, logicalWidth * from + gap + 16),
    newWidth = Math.max(viewportWidth, logicalWidth * to + gap + 16);
  const oldStart = (oldWidth - logicalWidth * from - gap) / 2,
    newStart = (newWidth - logicalWidth * to - gap) / 2;
  const right = spread.length === 2 && point.x > oldStart + spread[0].width * from + gap / 2;
  const oldOffset = right ? spread[0].width * from + gap : 0,
    newOffset = right ? spread[0].width * to + gap : 0;
  return {
    x: newStart + newOffset + (point.x - oldStart - oldOffset) * ratio,
    y: point.y <= 44 ? point.y : 44 + (point.y - 44) * ratio,
  };
}
