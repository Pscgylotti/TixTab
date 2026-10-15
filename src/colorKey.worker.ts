/// <reference lib="webworker" />
import { colorKeyPixels } from './colorKeyPixels';
self.onmessage = async ({
  data,
}: {
  data: { blob: Blob; color: string; tolerance: number; edge: number };
}) => {
  let bitmap: ImageBitmap | undefined, canvas: OffscreenCanvas | undefined;
  try {
    bitmap = await createImageBitmap(data.blob);
    if (bitmap.width * bitmap.height > 6_000_000 || Math.max(bitmap.width, bitmap.height) > 8192)
      throw Error('image-size');
    const scale = Math.min(1, data.edge / Math.max(bitmap.width, bitmap.height));
    canvas = new OffscreenCanvas(
      Math.max(1, Math.floor(bitmap.width * scale)),
      Math.max(1, Math.floor(bitmap.height * scale)),
    );
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    bitmap = undefined;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
      color = [1, 3, 5].map((i) => parseInt(data.color.slice(i, i + 2), 16));
    colorKeyPixels(pixels.data, color, data.tolerance);
    ctx.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    self.postMessage({ blob });
  } catch {
    self.postMessage({ error: 'image-size' });
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
};
