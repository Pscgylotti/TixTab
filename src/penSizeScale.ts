export function penSizeFromSlider(position: number) {
  const p = Math.max(0, Math.min(100, position));
  return Math.round((p <= 50 ? 0.5 + (p / 50) * 2.5 : 3 + ((p - 50) / 50) * 9) * 100) / 100;
}
export function penSizeToSlider(size: number) {
  const n = Math.max(0.5, Math.min(12, size));
  return n <= 3 ? ((n - 0.5) / 2.5) * 50 : 50 + ((n - 3) / 9) * 50;
}
