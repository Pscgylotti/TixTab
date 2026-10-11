import type { Page, PlacedImage } from './model';
import { reorderSelection, type ObjectOrder } from './objectSelection';

export const inkLayerIndex = (page: Page) =>
  Math.max(0, Math.min(page.images.length, page.inkLayer ?? page.images.length));
/** null is the single handwriting group, ordered together with every inserted object. */
export function pageLayers(page: Page): (PlacedImage | null)[] {
  const at = inkLayerIndex(page);
  return [...page.images.slice(0, at), null, ...page.images.slice(at)];
}
export function reorderPageLayers(
  page: Page,
  ids: readonly string[],
  order: ObjectOrder,
  inkSelected = false,
): Page {
  const selected = new Set(ids),
    layers = pageLayers(page);
  const sorted = reorderSelection(
    layers,
    (i) => (i === null ? inkSelected : selected.has(i.id)),
    order,
  );
  return sorted === layers
    ? page
    : {
        ...page,
        images: sorted.filter((i): i is PlacedImage => i !== null),
        inkLayer: sorted.indexOf(null),
      };
}
export function removePageImages(page: Page, ids: readonly string[]): Page {
  const removed = new Set(ids),
    layers = pageLayers(page).filter((i) => i === null || !removed.has(i.id));
  return {
    ...page,
    images: layers.filter((i): i is PlacedImage => i !== null),
    inkLayer: page.inkLayer === undefined ? undefined : layers.indexOf(null),
  };
}
export function appendPageImages(page: Page, objects: PlacedImage[]): Page {
  return { ...page, images: [...page.images, ...objects] };
}
