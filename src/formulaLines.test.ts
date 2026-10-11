import { describe, it, expect } from 'vitest';
import { formulaRows, strokeBounds, formulaCrop, mergeFormulaRows } from './formulaLines';
import type { Stroke } from './model';
const ink = (x: number, y: number, right: number, bottom: number): Stroke => ({
  id: String(x + y),
  tool: 'pen',
  color: '#000000',
  size: 3,
  points: [
    [x, y, 0.5],
    [right, bottom, 0.5],
  ],
});
describe('handwritten formula rows', () => {
  it('keeps a fraction, numerator, denominator, scripts and integral in one row, independent of writing order', () => {
    const strokes = [
      ink(20, 220, 100, 250),
      ink(90, 70, 94, 160),
      ink(120, 85, 150, 99),
      ink(120, 115, 150, 115),
      ink(120, 130, 150, 148),
      ink(175, 110, 195, 125),
      ink(193, 80, 207, 90),
      ink(200, 139, 211, 147),
    ];
    const rows = formulaRows(strokes);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ x: 87, y: 67, right: 214, bottom: 163 });
    expect(formulaRows([...strokes].reverse())).toEqual(rows);
  });
  it('does not split a tall single stroke and handles an empty drawing', () => {
    expect(formulaRows([ink(10, 5, 12, 300)])).toHaveLength(1);
    expect(formulaRows([])).toEqual([]);
    expect(strokeBounds([])).toBeNull();
  });
  it('handles large drawings without argument spreads and crops within canvas edges', () => {
    const s = ink(0, 0, 959, 639);
    s.points = Array.from({ length: 200000 }, (_, i) => [i % 960, i % 640, 0.5]);
    expect(formulaCrop(strokeBounds([s])!, 960, 640)).toEqual({ x: 0, y: 0, w: 960, h: 640 });
  });
  it('normalizes math wrappers and creates an editable KaTeX aligned block', () => {
    expect(mergeFormulaRows(['$$x=1$$', '```latex\ny=2\n```', '\\[z=3\\]'])).toBe(
      '\\begin{aligned}\nx=1 \\\\\ny=2 \\\\\nz=3\n\\end{aligned}',
    );
    expect(mergeFormulaRows(['\\(x\\)'])).toBe('x');
    expect(() => mergeFormulaRows(['$$ $$'])).toThrow();
  });
});
