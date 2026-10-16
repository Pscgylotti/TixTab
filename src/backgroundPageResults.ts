import type { Notebook, Page, PlacedImage } from './model';
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]))
  );
}
/** Apply processing changes to the latest object state, retaining concurrent moves/edits. */
function objectChanges(
  current: PlacedImage,
  before: PlacedImage,
  result: PlacedImage,
): PlacedImage {
  const next = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(result)])) {
    const field = key as keyof PlacedImage;
    if (field === 'group' && before.group && result.group && current.group) {
      next.group = {
        ...current.group,
        objects: imageChanges(current.group.objects, before.group.objects, result.group.objects),
      };
    } else if (result[field] !== before[field] && sameData(current[field], before[field])) {
      Object.assign(next, { [field]: result[field] });
    }
  }
  return next;
}
function imageChanges(current: PlacedImage[], before: PlacedImage[], results: PlacedImage[]) {
  const old = new Map(before.map((image) => [image.id, image]));
  const updates = new Map(results.map((image) => [image.id, image]));
  const next = current.flatMap((image) => {
    const base = old.get(image.id),
      result = updates.get(image.id);
    if (!base) return [image];
    if (!result) return sameData(image, base) ? [] : [image];
    return [objectChanges(image, base, result)];
  });
  for (const [index, image] of results.entries()) {
    if (old.has(image.id) || next.some((value) => value.id === image.id)) continue;
    const after = results
      .slice(index + 1)
      .find((value) => next.some((item) => item.id === value.id));
    const at = after
      ? next.findIndex((value) => value.id === after.id)
      : Math.min(index, next.length);
    next.splice(at, 0, image);
  }
  return next;
}
/** Update only fields owned by processing, preserving handwriting added while it ran. */
export function mergeBackgroundPages(
  notebook: Notebook,
  results: Page[],
  ocr = false,
  bases: Page[] = [],
): Notebook {
  const replacements = new Map(results.map((p) => [p.id, p]));
  const originals = new Map(bases.map((p) => [p.id, p]));
  return {
    ...notebook,
    pages: notebook.pages.map((page) => {
      const result = replacements.get(page.id);
      if (!result) return page;
      if (ocr) return { ...page, bitmapOcr: result.bitmapOcr };
      const base = originals.get(page.id);
      if (!base) return { ...page, score: result.score };
      const next = { ...page };
      if (result.images !== base.images)
        next.images = imageChanges(page.images, base.images, result.images);
      for (const field of ['score', 'bitmapOcr', 'inkLayer'] as const)
        if (result[field] !== base[field] && sameData(page[field], base[field]))
          Object.assign(next, { [field]: result[field] });
      return next;
    }),
  };
}
