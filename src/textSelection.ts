export interface GlyphHit {
  node: Text;
  start: number;
  end: number;
  rect: DOMRect;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const boundaries = new WeakMap<
  Text,
  { text: string; segments: { index: number; segment: string }[] }
>();
/** Use character boxes, not the nearest caret boundary: touching the right half
 * of the first glyph must still include that glyph when starting a drag. */
export function glyphAtPoint(
  root: HTMLElement,
  x: number,
  y: number,
  strict = false,
): GlyphHit | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const caret = doc.caretPositionFromPoint?.(x, y),
    range = caret ? null : doc.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? range?.startContainer,
    offset = caret?.offset ?? range?.startOffset ?? 0;
  if (!(node instanceof Text) || !node.length || !root.contains(node)) return null;
  let cached = boundaries.get(node);
  if (!cached || cached.text !== node.data) {
    cached = { text: node.data, segments: [...graphemes.segment(node.data)] };
    boundaries.set(node, cached);
  }
  const segments = cached.segments;
  let low = 0,
    high = segments.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (segments[mid].index < offset) low = mid + 1;
    else high = mid;
  }
  let best: GlyphHit | null = null,
    distance = Infinity;
  for (const segment of segments.slice(Math.max(0, low - 2), low + 2)) {
    const start = segment.index,
      end = start + segment.segment.length;
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const rect = r.getBoundingClientRect();
    const dx = Math.max(rect.left - x, 0, x - rect.right),
      dy = Math.max(rect.top - y, 0, y - rect.bottom),
      d = Math.hypot(dx, dy);
    if (d < distance) {
      best = { node, start, end, rect };
      distance = d;
    }
  }
  return strict && distance > 6 ? null : best;
}
export function selectGlyphs(anchor: GlyphHit, focus: GlyphHit) {
  const start = document.createRange(),
    end = document.createRange();
  start.setStart(anchor.node, anchor.start);
  start.collapse(true);
  end.setStart(focus.node, focus.start);
  end.collapse(true);
  const forward = start.compareBoundaryPoints(Range.START_TO_START, end) <= 0;
  getSelection()?.setBaseAndExtent(
    anchor.node,
    forward ? anchor.start : anchor.end,
    focus.node,
    forward ? focus.end : focus.start,
  );
}
export function selectWord(hit: GlyphHit) {
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(hit.node.data),
  ];
  const segment = segments.find(
    (s) => hit.start >= s.index && hit.start < s.index + s.segment.length,
  );
  if (segment)
    getSelection()?.setBaseAndExtent(
      hit.node,
      segment.index,
      hit.node,
      segment.index + segment.segment.length,
    );
}
