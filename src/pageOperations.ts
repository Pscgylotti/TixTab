import type { Notebook, Page, PlacedImage } from './model';
import { uid } from './model';
import { parsePageRange } from './pdfInsertion';
export type PageAction = 'rotate' | 'crop' | 'split';
export type CropMargins = { left: number; right: number; top: number; bottom: number };
export type PageOperation =
  { action: 'rotate'; angle: 90 | 180 | 270 } | { action: 'crop'; margins: CropMargins };
export function scopePages(scope: string, range: string, current: number, total: number) {
  if (scope === 'range' && !range.trim()) throw Error('page-range');
  return scope === 'current'
    ? [current]
    : scope === 'all'
      ? Array.from({ length: total }, (_, i) => i)
      : parsePageRange(range, total);
}
export function transformPage(page: Page, operation: PageOperation): Page {
  const w = page.width,
    h = page.height;
  const a = operation.action === 'rotate' ? operation.angle : 0;
  const crop =
    operation.action === 'crop' ? operation.margins : { left: 0, right: 0, top: 0, bottom: 0 };
  const dx = (w * crop.left) / 100,
    dy = (h * crop.top) / 100;
  const point = (x: number, y: number): [number, number] =>
    a === 90 ? [h - y, x] : a === 180 ? [w - x, h - y] : a === 270 ? [y, w - x] : [x - dx, y - dy];
  const box = (r: { x: number; y: number; width: number; height: number }) => {
    const p = point(r.x, r.y),
      q = point(r.x + r.width, r.y + r.height);
    return {
      x: Math.min(p[0], q[0]),
      y: Math.min(p[1], q[1]),
      width: Math.abs(q[0] - p[0]),
      height: Math.abs(q[1] - p[1]),
    };
  };
  const images: PlacedImage[] = page.images.map((image) => {
    if (a && image.group) {
      const groupPage: Page = {
        ...page,
        width: image.group.width,
        height: image.group.height,
        images: image.group.objects,
        strokes: [],
        reviews: undefined,
      };
      const transformed = transformPage(groupPage, operation);
      return {
        ...image,
        ...box(image),
        group: {
          width: transformed.width,
          height: transformed.height,
          objects: transformed.images,
        },
        displayData: undefined,
      };
    }
    return {
      ...image,
      ...box(image),
      ...(a ? { rotation: (((image.rotation ?? 0) + a) % 360) as 0 | 90 | 180 | 270 } : {}),
    };
  });
  const nextWidth = a % 180 ? h : w * (1 - (crop.left + crop.right) / 100),
    nextHeight = a % 180 ? w : h * (1 - (crop.top + crop.bottom) / 100);
  const scoreBox = (r: { x: number; y: number; width: number; height: number }) => {
    const b = box({ x: r.x * w, y: r.y * h, width: r.width * w, height: r.height * h });
    const x = Math.max(0, Math.min(0.999, b.x / nextWidth)),
      y = Math.max(0, Math.min(0.999, b.y / nextHeight));
    return {
      x,
      y,
      width: Math.min(1 - x, Math.max(0.001, b.width / nextWidth)),
      height: Math.min(1 - y, Math.max(0.001, b.height / nextHeight)),
    };
  };
  return {
    ...page,
    width: a % 180 ? h : w * (1 - (crop.left + crop.right) / 100),
    height: a % 180 ? w : h * (1 - (crop.top + crop.bottom) / 100),
    strokes: page.strokes.map((s) => ({
      ...s,
      points: s.points.map(([x, y, p]) => [...point(x, y), p]),
    })),
    images,
    reviews: page.reviews?.map((n) => ({ ...n, region: box(n.region) })),
    score: page.score
      ? {
          ...page.score,
          positioning: 'estimated',
          systems: page.score.systems.map((r) => scoreBox(r)),
          notes: page.score.notes.map((n) => ({
            ...n,
            region: scoreBox(n.region),
            ...(n.continuations
              ? {
                  continuations: n.continuations.map((c) => ({ ...c, region: scoreBox(c.region) })),
                }
              : {}),
          })),
        }
      : undefined,
    nativeRevision: uid(),
  };
}
export async function operatePages(
  notebook: Notebook,
  indices: number[],
  operation: PageOperation,
): Promise<Notebook> {
  return (await import('./pageOperationsEngine')).operatePages(notebook, indices, operation);
}
