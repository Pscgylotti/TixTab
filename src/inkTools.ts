import {
  PenLine,
  Pencil,
  Highlighter,
  Eraser,
  Hand,
  TextSelect,
  MousePointer2,
} from 'lucide-react';
export const inkTools = [
  { id: 'pen', label: '钢笔', icon: PenLine, key: 'P' },
  { id: 'ballpoint', label: '圆珠笔', icon: PenLine, key: 'B' },
  { id: 'pencil', label: '铅笔', icon: Pencil, key: 'N' },
  { id: 'highlighter', label: '荧光笔', icon: Highlighter, key: 'H' },
  { id: 'eraser', label: '橡皮擦', icon: Eraser, key: 'E' },
  { id: 'hand', label: '移动', icon: Hand, key: 'V' },
  { id: 'select', label: '选文', icon: TextSelect, key: 'T' },
  { id: 'object', label: '对象', icon: MousePointer2, key: 'S' },
] as const;
