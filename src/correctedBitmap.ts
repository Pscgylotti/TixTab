import type { Page } from './model';
export function hiddenSourceBitmap(page: Page, index: number) {
  const pending = [...page.images];
  while (pending.length) {
    const image = pending.pop()!;
    if (image.correction?.sourceImageIndex === index) return true;
    if (image.group) pending.push(...image.group.objects);
  }
  return false;
}
