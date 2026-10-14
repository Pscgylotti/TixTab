import type { Notebook } from './model';
export function historyViewportIndex(
  after: Notebook,
  target: number,
  leftPageId: string,
  mode: string,
) {
  const left = after.pages.findIndex((p) => p.id === leftPageId);
  return mode === 'dual' && left >= 0 && (target === left || target === left + 1) ? left : target;
}
/** Locate the edit by stable page identity, rather than a captured current index. */
export function historyTarget(before: Notebook, after: Notebook, activeId: string) {
  const old = new Map(before.pages.map((p, i) => [p.id, { page: p, index: i }])),
    now = new Map(after.pages.map((p, i) => [p.id, { page: p, index: i }]));
  const added = after.pages.find((p) => !old.has(p.id));
  if (added) return now.get(added.id)!.index;
  const changed = after.pages.filter((p) => {
    const previous = old.get(p.id)?.page;
    return (
      previous &&
      (p.strokes !== previous.strokes ||
        p.images !== previous.images ||
        p.bitmapOcr !== previous.bitmapOcr ||
        p.paper !== previous.paper ||
        p.inkLayer !== previous.inkLayer ||
        p.width !== previous.width ||
        p.height !== previous.height ||
        p.sourceIndex !== previous.sourceIndex)
    );
  });
  if (changed.length)
    return now.get(changed.find((p) => p.id === activeId)?.id ?? changed[0].id)!.index;
  const deleted = before.pages.find((p) => !now.has(p.id));
  if (deleted) return Math.min(old.get(deleted.id)!.index, after.pages.length - 1);
  const moves = after.pages
    .map((p, index) => ({ id: p.id, index, distance: Math.abs(index - old.get(p.id)!.index) }))
    .filter((p) => p.distance);
  if (moves.length) {
    moves.sort(
      (a, b) => b.distance - a.distance || Number(b.id === activeId) - Number(a.id === activeId),
    );
    return moves[0].index;
  }
  const oldMarks = new Map((before.bookmarks ?? []).map((b) => [b.id, b])),
    marks = [...(after.bookmarks ?? []), ...(before.bookmarks ?? [])];
  const bookmark = marks.find(
    (b) => oldMarks.get(b.id) !== b || !(after.bookmarks ?? []).some((a) => a.id === b.id),
  );
  if (bookmark && now.has(bookmark.pageId)) return now.get(bookmark.pageId)!.index;
  return now.get(activeId)?.index ?? 0;
}
