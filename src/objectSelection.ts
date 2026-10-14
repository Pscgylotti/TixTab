import type { PlacedImage } from './model';
import { imageBounds, type SpatialIndex } from './spatialIndex';
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
export function objectsInBox(
  images: PlacedImage[],
  box: ObjectBox,
  index?: SpatialIndex<PlacedImage>,
) {
  if (box.width <= 0 || box.height <= 0) return [];
  index?.update(images);
  return (index ? index.search(imageBounds(box)) : images)
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
export type ObjectOrder = 'front' | 'back' | 'forward' | 'backward';
/** Stable group order: crossing an unselected neighbour moves a selection exactly one layer. */
export function reorderObjects(images: PlacedImage[], ids: readonly string[], order: ObjectOrder) {
  const chosen = new Set(ids);
  return reorderSelection(images, (i) => chosen.has(i.id), order);
}
export function reorderSelection<T>(
  images: T[],
  chosen: (image: T) => boolean,
  order: ObjectOrder,
) {
  let result: T[];
  if (order === 'front' || order === 'back') {
    const selected = images.filter(chosen),
      rest = images.filter((i) => !chosen(i));
    result = order === 'front' ? [...rest, ...selected] : [...selected, ...rest];
  } else {
    result = [...images];
    if (order === 'forward') {
      for (let i = result.length - 2; i >= 0; i--)
        if (chosen(result[i]) && !chosen(result[i + 1]))
          [result[i], result[i + 1]] = [result[i + 1], result[i]];
    } else {
      for (let i = 1; i < result.length; i++)
        if (chosen(result[i]) && !chosen(result[i - 1]))
          [result[i], result[i - 1]] = [result[i - 1], result[i]];
    }
  }
  return result.every((image, i) => image === images[i]) ? images : result;
}
