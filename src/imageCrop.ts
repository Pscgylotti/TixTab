import type { PlacedImage } from './model';
import { renderColorKey } from './colorKey';
export interface ImageCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function validImageCropRect(r: ImageCropRect) {
  return (
    r &&
    [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.x + r.width <= 1.000001 &&
    r.y + r.height <= 1.000001
  );
}
async function cropPixels(data: string, rect: ImageCropRect, signal: AbortSignal) {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(await (await fetch(data, { signal })).blob());
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    const x = Math.min(bitmap.width - 1, Math.round(rect.x * bitmap.width));
    const y = Math.min(bitmap.height - 1, Math.round(rect.y * bitmap.height));
    canvas.width = Math.max(1, Math.min(bitmap.width - x, Math.round(rect.width * bitmap.width)));
    canvas.height = Math.max(
      1,
      Math.min(bitmap.height - y, Math.round(rect.height * bitmap.height)),
    );
    if (canvas.width * canvas.height > 32 * 1024 * 1024) throw Error('image-size');
    canvas
      .getContext('2d')!
      .drawImage(bitmap, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}
export async function cropPlacedImage(
  image: PlacedImage,
  rect: ImageCropRect,
  signal: AbortSignal,
): Promise<PlacedImage> {
  if (!validImageCropRect(rect)) throw Error('crop-region');
  const original = image.crop?.original ?? image.colorKey?.original ?? image.data;
  const nightOriginal = image.crop?.nightOriginal ?? image.nightData;
  const raw = await cropPixels(original, rect, signal);
  const data = image.colorKey
    ? await renderColorKey(raw, image.colorKey.color, image.colorKey.tolerance, signal)
    : raw;
  const nightData = nightOriginal ? await cropPixels(nightOriginal, rect, signal) : undefined;
  signal.throwIfAborted();
  const previous = image.crop?.rect ?? { x: 0, y: 0, width: 1, height: 1 };
  const swap = (image.rotation ?? 0) % 180;
  return {
    ...image,
    data,
    nightData,
    displayData: undefined,
    ocr: undefined,
    width: image.width * (swap ? rect.height / previous.height : rect.width / previous.width),
    height: image.height * (swap ? rect.width / previous.width : rect.height / previous.height),
    crop: { original, ...(nightOriginal ? { nightOriginal } : {}), rect },
    colorKey: image.colorKey ? { ...image.colorKey, original: raw } : undefined,
  };
}
