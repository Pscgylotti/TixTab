import type { Notebook } from './model';
import { editablePages } from './scratchPaper';
/** Bound unique PDF source buffers, not repeated pen edits sharing one source.
 * Keep the immediate undo even when a single source exceeds the budget. */
export function trimSourceHistory(history: Notebook[], current: Notebook, limit: number) {
  const buffers = new Set<ArrayBufferLike>();
  const pictures = new Set<string>();
  const imageData = (n: Notebook) => {
    const result: string[] = [];
    const pending = editablePages(n).flatMap((p) => p.images);
    while (pending.length) {
      const image = pending.pop()!;
      result.push(image.data);
      if (image.displayData) result.push(image.displayData);
      if (image.nightData) result.push(image.nightData);
      if (image.colorKey) result.push(image.colorKey.original);
      if (image.group) pending.push(...image.group.objects);
    }
    return result;
  };
  if (current.source) buffers.add(current.source.buffer);
  for (const data of imageData(current)) pictures.add(data);
  let bytes = 0,
    start = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const buffer = history[i].source?.buffer;
    const images = new Set(imageData(history[i]).filter((data) => !pictures.has(data)));
    const extra =
      (buffer && !buffers.has(buffer) ? buffer.byteLength : 0) +
      [...images].reduce((sum, data) => sum + data.length * 2, 0);
    if (extra && bytes + extra > limit && i !== history.length - 1) break;
    if (buffer) buffers.add(buffer);
    for (const data of images) pictures.add(data);
    bytes += extra;
    start = i;
  }
  return history.slice(start);
}
