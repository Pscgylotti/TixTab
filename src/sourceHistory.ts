import type { Notebook } from './model';
/** Bound unique PDF source buffers, not repeated pen edits sharing one source.
 * Keep the immediate undo even when a single source exceeds the budget. */
export function trimSourceHistory(history: Notebook[], current: Notebook, limit: number) {
  const buffers = new Set<ArrayBufferLike>();
  if (current.source) buffers.add(current.source.buffer);
  let bytes = 0,
    start = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const buffer = history[i].source?.buffer;
    const extra = buffer && !buffers.has(buffer) ? buffer.byteLength : 0;
    if (extra && bytes + extra > limit && i !== history.length - 1) break;
    if (buffer) buffers.add(buffer);
    bytes += extra;
    start = i;
  }
  return history.slice(start);
}
