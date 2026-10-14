import type { PlacedImage } from './model';
export function imageCorners(image: PlacedImage) {
  const { x, y, width: w, height: h } = image;
  const points = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const turn = (image.rotation ?? 0) / 90;
  return [...points.slice(turn), ...points.slice(0, turn)].flat();
}
export function imageDisplaySize(image: PlacedImage) {
  return (image.rotation ?? 0) % 180
    ? { width: image.height, height: image.width }
    : { width: image.width, height: image.height };
}
export function drawPlacedImage(
  ctx: CanvasRenderingContext2D,
  bitmap: CanvasImageSource,
  image: PlacedImage,
) {
  const size = imageDisplaySize(image);
  ctx.save();
  ctx.translate(image.x + image.width / 2, image.y + image.height / 2);
  ctx.rotate(((image.rotation ?? 0) * Math.PI) / 180);
  ctx.drawImage(bitmap, -size.width / 2, -size.height / 2, size.width, size.height);
  ctx.restore();
}
