/** Paper-coordinate radius. Pen pressure can approach zero with no radius floor. */
export function eraserPaperRadius(configured: number, pressure: number, pen: boolean) {
  const cap = Number.isFinite(configured) ? Math.max(0, Math.min(64, configured)) : 8;
  return cap * (pen ? (Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0) : 1);
}
