import type { Tool } from './model';
export type SizedInkTool = 'pen' | 'ballpoint' | 'pencil' | 'highlighter' | 'eraser';
export function sizeTool(tool: Tool): SizedInkTool {
  return ['pen', 'ballpoint', 'pencil', 'highlighter', 'eraser'].includes(tool)
    ? (tool as SizedInkTool)
    : 'pen';
}
export function savedInkSize(tool: SizedInkTool = 'pen') {
  const maximum = tool === 'eraser' ? 64 : tool === 'highlighter' ? 32 : 12;
  const minimum = tool === 'eraser' ? 0.1 : 0.5;
  try {
    const raw =
      localStorage.getItem(`tixtab.inkSize.${tool}`) ??
      (tool === 'eraser'
        ? null
        : localStorage.getItem(
            tool === 'highlighter' ? 'tixtab.highlighterSize' : 'tixtab.penSize',
          ));
    const value = Number(raw);
    if (value >= minimum && value <= maximum) return value;
  } catch {}
  return tool === 'eraser' ? 8 : tool === 'highlighter' ? 18 : 2.8;
}
export function saveInkSize(tool: SizedInkTool, size: number) {
  try {
    localStorage.setItem(`tixtab.inkSize.${tool}`, String(size));
  } catch {}
}
