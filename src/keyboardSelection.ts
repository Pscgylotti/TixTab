export type EditKey =
  'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'Backspace' | 'Delete';
/** Web fallback. Desktop uses native editing for visual wrapped-line movement. */
export function moveTextSelection(
  text: string,
  start: number,
  end: number,
  direction: string,
  key: EditKey,
  selecting: boolean,
) {
  const anchor = direction === 'backward' ? end : start;
  let focus = direction === 'backward' ? start : end;
  if (!selecting && start !== end && (key === 'ArrowLeft' || key === 'ArrowRight'))
    focus = key === 'ArrowLeft' ? start : end;
  else if (key === 'ArrowLeft') focus -= Array.from(text.slice(0, focus)).at(-1)?.length ?? 0;
  else if (key === 'ArrowRight') focus += Array.from(text.slice(focus))[0]?.length ?? 0;
  else {
    const lineStart = text.lastIndexOf('\n', focus - 1) + 1;
    const nextBreak = text.indexOf('\n', focus),
      lineEnd = nextBreak < 0 ? text.length : nextBreak;
    if (key === 'Home') focus = lineStart;
    if (key === 'End') focus = lineEnd;
    if (key === 'ArrowUp') {
      const previous = text.lastIndexOf('\n', lineStart - 2) + 1;
      focus = lineStart ? Math.min(lineStart - 1, previous + focus - lineStart) : 0;
    }
    if (key === 'ArrowDown') {
      const next = text.indexOf('\n', lineEnd + 1);
      focus =
        lineEnd < text.length
          ? Math.min(next < 0 ? text.length : next, lineEnd + 1 + focus - lineStart)
          : text.length;
    }
  }
  focus = Math.max(0, Math.min(text.length, focus));
  return selecting
    ? {
        start: Math.min(anchor, focus),
        end: Math.max(anchor, focus),
        direction: focus < anchor ? ('backward' as const) : ('forward' as const),
      }
    : { start: focus, end: focus, direction: 'none' as const };
}
