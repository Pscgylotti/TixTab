import { describe, it, expect } from 'vitest';
import { blankPage, type Stroke } from './model';
import {
  decodeInk,
  inkBox,
  placeInk,
  strokeInBox,
  translateInk,
  selectInk,
  selectedInk,
} from './inkSelection';
const stroke: Stroke = {
  id: 'a',
  tool: 'pen',
  color: '#112233',
  size: 3,
  points: [
    [0, 20, 0.2],
    [100, 20, 0.8],
  ],
};
describe('editable ink selection', () => {
  it('selects a crossing segment even when both endpoints are outside, but rejects empty nearby space', () => {
    expect(strokeInBox(stroke, { minX: 40, minY: 10, maxX: 60, maxY: 30 })).toBe(true);
    expect(strokeInBox(stroke, { minX: 40, minY: 40, maxX: 60, maxY: 60 })).toBe(false);
    expect(
      strokeInBox(
        { ...stroke, points: [[50, 20, 0.4]] },
        { minX: 40, minY: 10, maxX: 60, maxY: 30 },
      ),
    ).toBe(true);
  });
  it('moves editable geometry without modifying the source, pressure, style or identity', () => {
    const moved = translateInk([stroke], 15, -5)[0];
    expect(moved).toEqual({
      ...stroke,
      points: [
        [15, 15, 0.2],
        [115, 15, 0.8],
      ],
    });
    expect(stroke.points[0]).toEqual([0, 20, 0.2]);
    expect(inkBox([stroke])).not.toBeNull();
  });
  it('validates clipboard data and gives pasted strokes fresh identities', () => {
    const payload = {
      type: 'tixtab-ink',
      version: 1,
      pageId: 'original',
      strokes: [stroke],
    } as const;
    const decoded = decodeInk(JSON.stringify(payload))!;
    expect(decoded).not.toBeNull();
    const page = blankPage();
    page.id = 'other';
    const pasted = placeInk(decoded, page);
    expect(pasted[0].id).not.toBe(stroke.id);
    expect(pasted[0].points.map((p) => p[2])).toEqual([0.2, 0.8]);
    expect(pasted[0].color).toBe(stroke.color);
    expect(decodeInk(JSON.stringify({ ...payload, strokes: [stroke, stroke] }))).toBeNull();
    expect(
      decodeInk(
        JSON.stringify({ ...payload, strokes: [{ ...stroke, points: [[Infinity, 0, 0.5]] }] }),
      ),
    ).toBeNull();
    expect(decodeInk('{broken')).toBeNull();
  });
  it('does not clear another page selection when an inactive layer receives input', () => {
    selectInk('page-a', ['a']);
    selectInk('page-b', []);
    expect(selectedInk('page-a')).toEqual(['a']);
    selectInk('page-a', []);
    expect(selectedInk('page-a')).toEqual([]);
  });
});
