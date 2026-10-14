import { t } from './i18n';
import { isImageFile, sanitizeSvg } from './svgImport';

export const MAX_CHAT_IMAGES = 6;
export const MAX_CHAT_IMAGE_BYTES = 12_000_000;
export interface ChatImageAttachment {
  id: string;
  name: string;
  image: string;
}

/** Parse a bounded, ordered set without expanding arbitrary ranges. */
export function attachmentPages(value: string, count: number): number[] {
  const result = new Set<number>();
  for (const part of value.trim().split(/[,，\s]+/)) {
    const match = /^(\d+)(?:[-–](\d+))?$/.exec(part);
    if (!match) throw Error(t('请输入页码或范围，例如 1, 3-4（最多三页）。'));
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > count || end - start > 2)
      throw Error(t('页码超出范围或超过三页。'));
    for (let n = start; n <= end; n++) result.add(n - 1);
    if (result.size > 3) throw Error(t('每次最多附加三页，请先移除其它页面。'));
  }
  return [...result];
}

export function checkChatImages(images: string[]) {
  if (
    images.length > MAX_CHAT_IMAGES ||
    images.reduce((sum, image) => sum + image.length, 0) > MAX_CHAT_IMAGE_BYTES
  )
    throw Error(t('最多附加六张图片，总大小需小于 12 MB。'));
}

/** Normalize uploads to bounded JPEG vision input; never send raw SVG to a provider. */
export async function chatImage(file: File): Promise<ChatImageAttachment> {
  if (!isImageFile(file) || file.size > 32_000_000) throw Error('image-invalid');
  const url = /\.svg$/i.test(file.name)
    ? sanitizeSvg(await file.text()).dataURL
    : URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement('canvas');
  try {
    image.src = url;
    await image.decode();
    const scale = Math.min(
      1,
      2048 / Math.max(image.naturalWidth, image.naturalHeight),
      Math.sqrt(2_000_000 / (image.naturalWidth * image.naturalHeight)),
    );
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.88);
    if (data.length > 3_000_000) throw Error(t('图片过大，请缩小后重试。'));
    return { id: crypto.randomUUID(), name: file.name.slice(0, 160), image: data };
  } finally {
    canvas.width = canvas.height = 0;
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}
