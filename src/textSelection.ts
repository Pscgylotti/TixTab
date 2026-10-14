import RBush from 'rbush';

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
interface TextBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  node: Text;
  horizontal: boolean;
  rtl: boolean;
}
const layouts = new WeakMap<
  HTMLElement,
  {
    width: number;
    height: number;
    tree: RBush<TextBox>;
  }
>();
export function invalidateTextLayout(root: HTMLElement) {
  layouts.delete(root);
}
function textLayout(root: HTMLElement, bounds: DOMRect) {
  let layout = layouts.get(root);
  if (layout?.width === bounds.width && layout.height === bounds.height) return layout;
  const boxes: TextBox[] = [];
  for (const span of root.querySelectorAll('span')) {
    const node = span.firstChild;
    if (!(node instanceof Text) || !node.data.trim() || span.getAttribute('role') === 'img')
      continue;
    const rect = span.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    // Cache page-relative geometry: scrolling/panning only changes the root origin.
    boxes.push({
      minX: rect.left - bounds.left,
      minY: rect.top - bounds.top,
      maxX: rect.right - bounds.left,
      maxY: rect.bottom - bounds.top,
      node,
      horizontal:
        !parseFloat(span.style.getPropertyValue('--rotate')) &&
        !Number(
          span.closest<HTMLElement>('[data-main-rotation]')?.dataset.mainRotation ??
            root.dataset.mainRotation,
        ),
      rtl: span.dir === 'rtl',
    });
  }
  layout = { width: bounds.width, height: bounds.height, tree: new RBush<TextBox>().load(boxes) };
  layouts.set(root, layout);
  return layout;
}
function spatialText(root: HTMLElement, x: number, y: number) {
  const bounds = root.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const { tree } = textLayout(root, bounds);
  const px = x - bounds.left,
    py = y - bounds.top;
  let best: TextBox | null = null,
    score = Infinity,
    startMargin = false;
  for (const box of tree.search({ minX: px - 28, maxX: px + 28, minY: py - 6, maxY: py + 6 })) {
    const height = box.maxY - box.minY;
    const dy = Math.max(box.minY - py, 0, py - box.maxY);
    if (dy > Math.min(6, height * 0.2)) continue;
    const dx = Math.max(box.minX - px, 0, px - box.maxX);
    if (dx > 6) {
      // Only a visual line start receives extra space. Nearby same-line spans
      // prevent interior words from acquiring their own left-hand hit zone.
      if (
        !box.horizontal ||
        box.rtl ||
        px >= box.minX ||
        dx > Math.min(28, Math.max(12, height * 0.8))
      )
        continue;
      const middle = (box.minY + box.maxY) / 2;
      const preceding = tree
        .search({
          minX: box.minX - height * 2,
          maxX: box.minX,
          minY: middle - height * 0.15,
          maxY: middle + height * 0.15,
        })
        .some((other) => other !== box && other.maxX <= box.minX + 0.5);
      if (preceding) continue;
    }
    const nextScore = dy * 8 + dx;
    if (nextScore < score) {
      best = box;
      score = nextScore;
      startMargin = dx > 6;
    }
  }
  return best ? { node: best.node, startMargin } : null;
}
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
  const nativeNode = caret?.offsetNode ?? range?.startContainer,
    offset = caret?.offset ?? range?.startOffset ?? 0;
  const spatial = spatialText(root, x, y);
  const node = spatial?.node ?? (!strict ? nativeNode : null);
  if (!(node instanceof Text) || !node.length || !root.contains(node)) return null;
  let cached = boundaries.get(node);
  if (!cached || cached.text !== node.data) {
    cached = { text: node.data, segments: [...graphemes.segment(node.data)] };
    boundaries.set(node, cached);
  }
  const segments = cached.segments;
  const boxAt = (i: number) => {
    const segment = segments[i],
      r = document.createRange();
    r.setStart(node, segment.index);
    r.setEnd(node, segment.index + segment.segment.length);
    return r.getBoundingClientRect();
  };
  let low = 0,
    high = segments.length;
  if (node === nativeNode) {
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (segments[mid].index < offset) low = mid + 1;
      else high = mid;
    }
  } else {
    // Browser caret lookup can return an entirely different line in blank
    // margins. Locate a glyph inside the geometrically chosen span instead.
    const first = boxAt(0),
      last = boxAt(segments.length - 1);
    const vertical = Math.abs(last.top - first.top) > Math.abs(last.left - first.left);
    const center = (r: DOMRect) => (vertical ? (r.top + r.bottom) / 2 : (r.left + r.right) / 2);
    const direction = center(last) >= center(first) ? 1 : -1;
    const point = (vertical ? y : x) * direction;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (center(boxAt(mid)) * direction < point) low = mid + 1;
      else high = mid;
    }
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
  return strict && distance > 6 && !spatial?.startMargin ? null : best;
}
/** The same leading boundary used when a drag begins, in screen coordinates. */
export function glyphCaret(hit: GlyphHit) {
  const range = document.createRange();
  range.setStart(hit.node, hit.start);
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  return rect.height || rect.width
    ? rect
    : new DOMRect(hit.rect.left, hit.rect.top, 0, hit.rect.height);
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
