import type { TextContent } from './pdfTextContent';
import { multiply } from './pdfNightGeometry';

type TextItem = Extract<TextContent['items'][number], { str: string }>;
type TextStyle = TextContent['styles'][string];
/** Quad in reading order: start/top, end/top, end/bottom, start/bottom.
 * Keep the baseline direction until a substring has been sliced. An axis-aligned
 * box alone loses the direction of rotated text (for example arXiv sidebars). */
export function pdfTextQuad(
  item: TextItem,
  style: TextStyle | undefined,
  viewport: { transform: number[]; scale: number; userUnit?: number },
) {
  const m = multiply(viewport.transform, item.transform);
  let dx = m[0],
    dy = m[1],
    ux = m[2],
    uy = m[3];
  if (style?.vertical) {
    // Vertical writing advances down the font's vertical axis.
    [dx, dy, ux, uy] = [-ux, -uy, dx, dy];
  }
  const length = Math.hypot(dx, dy) || 1,
    width = Math.abs(
      (style?.vertical ? item.height : item.width) * viewport.scale * (viewport.userUnit ?? 1),
    ),
    ascent = style?.ascent ?? (style?.descent === undefined ? 0.8 : 1 + style.descent),
    x = m[4] + ux * ascent,
    y = m[5] + uy * ascent,
    vx = (dx / length) * width,
    vy = (dy / length) * width;
  return [x, y, x + vx, y + vy, x + vx - ux, y + vy - uy, x - ux, y - uy];
}

export function sliceTextQuad(quad: number[], start = 0, end = 1) {
  const dx = quad[2] - quad[0],
    dy = quad[3] - quad[1];
  return [
    quad[0] + dx * start,
    quad[1] + dy * start,
    quad[0] + dx * end,
    quad[1] + dy * end,
    quad[6] + dx * end,
    quad[7] + dy * end,
    quad[6] + dx * start,
    quad[7] + dy * start,
  ];
}

export function textRunGap(previous: number[], next: number[]) {
  const dx = previous[2] - previous[0],
    dy = previous[3] - previous[1],
    length = Math.hypot(dx, dy) || 1,
    nx = dx / length,
    ny = dy / length,
    x = next[0] - previous[2],
    y = next[1] - previous[3],
    height = Math.max(
      Math.hypot(previous[6] - previous[0], previous[7] - previous[1]),
      Math.hypot(next[6] - next[0], next[7] - next[1]),
    );
  return Math.abs(x * -ny + y * nx) > height * 0.5 || x * nx + y * ny > height * 0.18;
}
