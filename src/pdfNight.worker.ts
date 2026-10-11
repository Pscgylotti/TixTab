import type { ImagePolygon } from './pdfNightGeometry';
import { transformNightPixels } from './pdfNightColors';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = ({
  data,
}: MessageEvent<{ id: number; bitmap: ImageBitmap; polygons: ImagePolygon[] }>) => {
  const { id, bitmap, polygons } = data;
  try {
    const { width, height } = bitmap,
      canvas = new OffscreenCanvas(width, height),
      ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, width, height);
    let mask: Uint8ClampedArray | undefined;
    if (polygons.length) {
      const m = new OffscreenCanvas(width, height),
        c = m.getContext('2d', { willReadFrequently: true })!;
      c.fillStyle = 'white';
      for (const p of polygons) {
        c.beginPath();
        c.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
        c.closePath();
        c.fill();
      }
      mask = c.getImageData(0, 0, width, height).data;
    }
    transformNightPixels(pixels.data, mask);
    ctx.putImageData(pixels, 0, 0);
    const output = canvas.transferToImageBitmap();
    scope.postMessage({ id, bitmap: output }, [output]);
  } catch (error) {
    bitmap.close();
    scope.postMessage({ id, error: String(error) });
  }
};
