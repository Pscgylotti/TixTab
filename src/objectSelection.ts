import type { PlacedImage } from './model';
export interface ObjectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function objectBox(images: PlacedImage[], ids: readonly string[]): ObjectBox | null {
  const chosen = new Set(ids),
    objects = images.filter((i) => chosen.has(i.id));
  if (!objects.length) return null;
  const x = Math.min(...objects.map((i) => i.x)),
    y = Math.min(...objects.map((i) => i.y));
  return {
    x,
    y,
    width: Math.max(...objects.map((i) => i.x + i.width)) - x,
    height: Math.max(...objects.map((i) => i.y + i.height)) - y,
  };
}
export function objectsInBox(images: PlacedImage[], box: ObjectBox) {
  if (box.width <= 0 || box.height <= 0) return [];
  return images
    .filter(
      (i) =>
        i.x < box.x + box.width &&
        i.x + i.width > box.x &&
        i.y < box.y + box.height &&
        i.y + i.height > box.y,
    )
    .map((i) => i.id);
}
export function transformObjects(
  images: PlacedImage[],
  ids: readonly string[],
  from: ObjectBox,
  to: ObjectBox,
) {
  const chosen = new Set(ids),
    scale = to.width / from.width;
  return images.map((i) =>
    chosen.has(i.id)
      ? {
          ...i,
          x: to.x + (i.x - from.x) * scale,
          y: to.y + (i.y - from.y) * scale,
          width: i.width * scale,
          height: i.height * scale,
        }
      : i,
  );
}
