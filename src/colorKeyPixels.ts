/** Match each RGB channel independently; existing alpha is retained outside the key. */
export function colorKeyPixels(
  pixels: Uint8ClampedArray,
  color: readonly number[],
  tolerance: number,
) {
  for (let i = 0; i < pixels.length; i += 4)
    if (
      Math.abs(pixels[i] - color[0]) <= tolerance &&
      Math.abs(pixels[i + 1] - color[1]) <= tolerance &&
      Math.abs(pixels[i + 2] - color[2]) <= tolerance
    )
      pixels[i + 3] = 0;
}
