/** IDs survive reorder/insert; a gesture is recomputed from its initial set so reversing shrinks it. */
export function pageSelectionRange(
  ids: readonly string[],
  base: readonly string[],
  from: number,
  to: number,
  selected = true,
) {
  const result = new Set(base);
  for (
    let i = Math.max(0, Math.min(from, to));
    i <= Math.min(ids.length - 1, Math.max(from, to));
    i++
  ) {
    if (selected) result.add(ids[i]);
    else result.delete(ids[i]);
  }
  return ids.filter((id) => result.has(id));
}
