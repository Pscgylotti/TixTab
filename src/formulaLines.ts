import type { Stroke } from './model';
export interface FormulaBounds {
  x: number;
  y: number;
  right: number;
  bottom: number;
}
export function strokeBounds(strokes: readonly Stroke[]): FormulaBounds | null {
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const stroke of strokes)
    for (const [px, py] of stroke.points) {
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const pad = Math.max(2, stroke.size);
      x = Math.min(x, px - pad);
      y = Math.min(y, py - pad);
      right = Math.max(right, px + pad);
      bottom = Math.max(bottom, py + pad);
    }
  return Number.isFinite(x) ? { x, y, right, bottom } : null;
}
/** Merge ink intervals, including fraction bars and scripts separated by a small gap.
 * Rows must have a clear blank band. No raster scans or per-pointer calculations. */
export function formulaRows(strokes: readonly Stroke[], gap = 24): FormulaBounds[] {
  const bounds = strokes
    .map((s) => strokeBounds([s]))
    .filter((b): b is FormulaBounds => !!b)
    .sort((a, b) => a.y - b.y);
  const rows: FormulaBounds[] = [];
  for (const box of bounds) {
    const last = rows.at(-1);
    if (last && box.y <= last.bottom + gap) {
      last.x = Math.min(last.x, box.x);
      last.right = Math.max(last.right, box.right);
      last.bottom = Math.max(last.bottom, box.bottom);
    } else rows.push({ ...box });
  }
  return rows;
}
export function formulaCrop(bounds: FormulaBounds, width: number, height: number) {
  const x = Math.max(0, Math.floor(bounds.x - 20)),
    y = Math.max(0, Math.floor(bounds.y - 20));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width, Math.ceil(bounds.right + 20)) - x),
    h: Math.max(1, Math.min(height, Math.ceil(bounds.bottom + 20)) - y),
  };
}
export function mergeFormulaRows(values: string[]) {
  const rows = values.map((value) => {
    let text = value
      .trim()
      .replace(/^```(?:latex|tex)?\s*\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();
    for (const [open, close] of [
      ['$$', '$$'],
      ['\\[', '\\]'],
      ['\\(', '\\)'],
      ['$', '$'],
    ]) {
      if (text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, -close.length).trim();
        break;
      }
    }
    if (!text) throw new Error('Empty formula result');
    return text;
  });
  return rows.length <= 1
    ? (rows[0] ?? '')
    : `\\begin{aligned}\n${rows.join(' \\\\\n')}\n\\end{aligned}`;
}
