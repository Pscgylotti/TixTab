import { uid, isPicture, validObjectGroup, type Page, type PlacedImage } from './model';
import { objectBox } from './objectSelection';
import { pageLayers } from './pageLayers';

/** Restore children using the group's current transform. Original editing metadata survives. */
export function groupChildren(image: PlacedImage): PlacedImage[] {
  if (!image.group) return [image];
  const group = image.group;
  return group.objects.map((child) => ({
    ...child,
    x: image.x + (child.x / group.width) * image.width,
    y: image.y + (child.y / group.height) * image.height,
    width: (child.width / group.width) * image.width,
    height: (child.height / group.height) * image.height,
  }));
}
/** Flatten only the display/export projection, retaining the editable hierarchy in the project. */
export function groupLeaves(image: PlacedImage): PlacedImage[] {
  return image.group ? groupChildren(image).flatMap(groupLeaves) : [image];
}
const urls = new WeakMap<NonNullable<PlacedImage['group']>, Map<string, string>>();
const xmlAttribute = (value: string) =>
  value.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);
const rotatedDisplays = new WeakMap<PlacedImage, Map<string, string>>();
export function groupDisplay(image: PlacedImage, night = false, pdfNight = false): string {
  if (!image.group) {
    const data =
      pdfNight && image.scratchPage && image.nightData
        ? image.nightData
        : (image.displayData ?? image.data);
    if (!image.rotation) return data;
    const cached = rotatedDisplays.get(image)?.get(data);
    if (cached) return cached;
    const swap = image.rotation % 180;
    const w = swap ? image.height : image.width,
      h = swap ? image.width : image.height;
    const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${image.width} ${image.height}"><image preserveAspectRatio="none" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" transform="translate(${image.width / 2} ${image.height / 2}) rotate(${image.rotation})" href="${xmlAttribute(data)}"/></svg>`;
    const result = 'data:image/svg+xml;base64,' + btoa(xml);
    let cache = rotatedDisplays.get(image);
    if (!cache) rotatedDisplays.set(image, (cache = new Map()));
    cache.set(data, result);
    return result;
  }
  const group = image.group,
    key = `${night}:${pdfNight}`;
  let cache = urls.get(group);
  if (!cache) {
    cache = new Map();
    urls.set(group, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${group.width}" height="${group.height}" viewBox="0 0 ${group.width} ${group.height}">${group.objects
    .flatMap(groupLeaves)
    .map((child) => {
      const filter = isPicture(child)
        ? pdfNight
          ? child.scratchPage
            ? child.nightData
              ? ''
              : 'invert(0.9) hue-rotate(180deg)'
            : 'brightness(0.62)'
          : ''
        : night
          ? 'invert(0.9) hue-rotate(180deg)'
          : '';
      return `<image preserveAspectRatio="none" x="${child.x}" y="${child.y}" width="${child.width}" height="${child.height}" href="${xmlAttribute(groupDisplay(child, night, pdfNight))}"${filter ? ` style="filter:${filter}"` : ''}/>`;
    })
    .join('')}</svg>`;
  const data = 'data:image/svg+xml;base64,' + btoa(xml);
  cache.set(key, data);
  return data;
}
/** Composite SVG for screen rendering, plus a bounded transparent PNG for legacy consumers. */
export async function createObjectGroup(page: Page, ids: readonly string[]): Promise<PlacedImage> {
  const selected = new Set(ids),
    originals = page.images.filter((i) => selected.has(i.id));
  if (originals.length < 2) throw Error('group-selection');
  const box = objectBox(
    originals,
    originals.map((i) => i.id),
  )!;
  const children = originals.map((child) => ({ ...child, x: child.x - box.x, y: child.y - box.y }));
  const hierarchy = { width: box.width, height: box.height, objects: children };
  if (!validObjectGroup(hierarchy)) throw Error('group-limit');
  const image: PlacedImage = {
    id: uid(),
    kind: 'image',
    data: '',
    ...box,
    group: hierarchy,
  };
  image.displayData = groupDisplay(image);
  const canvas = document.createElement('canvas');
  const scale = Math.min(
    4,
    Math.sqrt(8_000_000 / (box.width * box.height)),
    8192 / Math.max(box.width, box.height),
  );
  canvas.width = Math.max(1, Math.ceil(box.width * scale));
  canvas.height = Math.max(1, Math.ceil(box.height * scale));
  try {
    const bitmap = new Image();
    bitmap.src = image.displayData;
    await bitmap.decode();
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Let the browser schedule PNG encoding instead of blocking the input task.
    // Keep the exact same raster, PNG format and editable SVG/hierarchy.
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(Error('group-encode'))),
        'image/png',
      ),
    );
    image.data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string' ? resolve(reader.result) : reject(Error('group-encode'));
      reader.onerror = reader.onabort = () => reject(Error('group-encode'));
      reader.readAsDataURL(blob);
    });
    return image;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
function withLayers(page: Page, layers: (PlacedImage | null)[]): Page {
  return {
    ...page,
    images: layers.filter((i): i is PlacedImage => i !== null),
    inkLayer: layers.indexOf(null),
  };
}
export function mergePageObjects(page: Page, ids: readonly string[], group: PlacedImage): Page {
  const selected = new Set(ids),
    layers = pageLayers(page);
  let last = -1;
  layers.forEach((i, n) => {
    if (i !== null && selected.has(i.id)) last = n;
  });
  return withLayers(
    page,
    layers.flatMap((i, n) => (n === last ? [group] : i !== null && selected.has(i.id) ? [] : [i])),
  );
}
export function ungroupPageObject(page: Page, image: PlacedImage): { page: Page; ids: string[] } {
  const children = groupChildren(image).map((i) => ({ ...i, id: uid() }));
  return {
    page: withLayers(
      page,
      pageLayers(page).flatMap((i) => (i?.id === image.id ? children : [i])),
    ),
    ids: children.map((i) => i.id),
  };
}
