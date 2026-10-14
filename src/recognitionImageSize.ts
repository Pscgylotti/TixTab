/** Recognition services bound decoded pixels and the longest edge independently.
 * Round down before allocating: rounding up at the pixel limit exceeds it. */
export function recognitionImageSize(width: number, height: number, maxScale = 1) {
  if (![width, height, maxScale].every((value) => Number.isFinite(value) && value > 0))
    throw new RangeError('Invalid recognition image dimensions');
  const limit = Math.min(
    maxScale,
    Math.sqrt(4_000_000 / width / height),
    8192 / Math.max(width, height),
  );
  const pixelsWide = Math.max(1, Math.floor(width * limit)),
    pixelsHigh = Math.max(1, Math.floor(height * limit));
  return {
    width: pixelsWide,
    height: pixelsHigh,
    scale: Math.min(pixelsWide / width, pixelsHigh / height),
  };
}
