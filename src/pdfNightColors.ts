/** In-place, display-only transform. Never samples neighbours or changes coverage:
 * retain the original grayscale antialiasing ramp without a sharpening/blur pass.
 * Suppress small RGB differences which become colored fringes on dark paper.
 * Saturated vector colors and image-mask pixels retain the existing hue policy.
 */
const saturationByChroma = Float32Array.from({ length: 256 }, (_, chroma) => {
  const t = Math.min(1, Math.max(0, (chroma - 16) / 32));
  return 0.7 * t * t * (3 - 2 * t);
});
export function transformNightPixels(p: Uint8ClampedArray, mask?: Uint8ClampedArray) {
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i],
      g = p[i + 1],
      b = p[i + 2];
    const photoAlpha = mask?.[i + 3] ?? 0;
    // Fully covered bitmap pixels need only the existing brightness mapping.
    // Keep the original arithmetic for antialiased/partial mask boundaries.
    if (photoAlpha === 255) {
      p[i] = r * 0.62;
      p[i + 1] = g * 0.62;
      p[i + 2] = b * 0.62;
      continue;
    }
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const target = 230 - (l * 202) / 255;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    // Smooth transition avoids a color discontinuity in antialiased colored art.
    const saturation = saturationByChroma[chroma];
    const photo = photoAlpha / 255;
    p[i] = (target + (r - l) * saturation) * (1 - photo) + r * 0.62 * photo;
    p[i + 1] = (target + 4 + (g - l) * saturation) * (1 - photo) + g * 0.62 * photo;
    p[i + 2] = (target + 11 + (b - l) * saturation) * (1 - photo) + b * 0.62 * photo;
  }
}
