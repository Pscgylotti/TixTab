/** Polygon coordinates are image pixels from an engine, normalized to [0,1] when saved. */
export interface OcrLine {
  text: string;
  polygon: number[];
  confidence?: number;
}
export interface OcrAnnotation {
  text: string;
  lines: OcrLine[];
  engine: string;
}
export function validOcr(value: unknown): value is OcrAnnotation {
  const v = value as OcrAnnotation | null;
  return (
    !!v &&
    typeof v.text === 'string' &&
    v.text.length <= 100000 &&
    typeof v.engine === 'string' &&
    v.engine.length <= 200 &&
    Array.isArray(v.lines) &&
    v.lines.length <= 10000 &&
    v.lines.every(
      (l) =>
        !!l &&
        typeof l.text === 'string' &&
        l.text.length <= 10000 &&
        Array.isArray(l.polygon) &&
        l.polygon.length === 8 &&
        l.polygon.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
        (l.confidence === undefined ||
          (Number.isFinite(l.confidence) && l.confidence >= 0 && l.confidence <= 100)),
    )
  );
}
export function normalizeOcr(
  text: string,
  lines: OcrLine[] | undefined,
  width: number,
  height: number,
  engine: string,
): OcrAnnotation {
  const normalized = (lines ?? [])
    .filter(
      (l) =>
        !!l &&
        typeof l.text === 'string' &&
        l.text.trim() &&
        Array.isArray(l.polygon) &&
        l.polygon.length === 8 &&
        l.polygon.every(Number.isFinite),
    )
    .slice(0, 10000)
    .map((l) => ({
      text: l.text.slice(0, 10000),
      polygon: l.polygon.map((n, i) => Math.max(0, Math.min(1, n / (i % 2 ? height : width)))),
      ...(Number.isFinite(l.confidence)
        ? { confidence: Math.max(0, Math.min(100, l.confidence!)) }
        : {}),
    }));
  // Keep text and line order identical so offsets used by search are exact.
  return {
    text: (normalized.length ? normalized.map((l) => l.text).join('\n') : text).slice(0, 100000),
    lines: normalized,
    engine: engine.slice(0, 200),
  };
}
export function tesseractLines(blocks: unknown): OcrLine[] {
  if (!Array.isArray(blocks)) return [];
  const result: OcrLine[] = [];
  for (const block of blocks)
    for (const paragraph of block.paragraphs ?? [])
      for (const line of paragraph.lines ?? []) {
        const b = line.bbox;
        if (b && typeof line.text === 'string' && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite))
          result.push({
            text: line.text.trim(),
            confidence: line.confidence,
            polygon: [b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1],
          });
      }
  return result;
}
