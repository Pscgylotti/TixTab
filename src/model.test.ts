import { describe, expect, it } from 'vitest';
import { hitStroke, isEraser, isPicture, newNotebook, type Stroke } from './model';
import { outline } from './ink';
import { decodeProject, encodeProject } from './storage';
const s: Stroke = {
  id: 's',
  color: '#23324d',
  size: 8,
  tool: 'pen',
  points: [
    [0, 0, 0.5],
    [100, 0, 0.5],
  ],
};
describe('笔输入与工程', () => {
  it('识别两种标准背面擦除信号，普通笔侧键不擦除', () => {
    expect(isEraser({ pointerType: 'pen', button: 5, buttons: 32 })).toBe(true);
    expect(isEraser({ pointerType: 'pen', button: -1, buttons: 32 })).toBe(true);
    expect(isEraser({ pointerType: 'pen', button: 2, buttons: 2 })).toBe(false);
    expect(isEraser({ pointerType: 'mouse', button: 5, buttons: 32 })).toBe(false);
  });
  it('擦除命中整笔划，包括快速擦除交叉线段', () => {
    expect(hitStroke(s, [50, -30, 0], [50, 30, 0], 5)).toBe(true);
    expect(hitStroke(s, [50, 40, 0], [60, 40, 0], 5)).toBe(false);
    expect(hitStroke(s, [102, 2, 0], [102, 2, 0], 5)).toBe(true);
  });
  it('真实压力改变钢笔轮廓宽度，圆珠笔维持固定宽度', () => {
    const width = (tool: Stroke['tool'], pressure: number) => {
      const ys = outline({
        ...s,
        tool,
        points: Array.from(
          { length: 21 },
          (_, i) => [i * 5, 0, pressure] as [number, number, number],
        ),
      }).map((p) => p[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(width('pen', 0.9)).toBeGreaterThan(width('pen', 0.1) * 2);
    expect(width('ballpoint', 0.9)).toBeCloseTo(width('ballpoint', 0.1));
  });
  it('工程往返保留原始字节、页序和笔迹压力', () => {
    const n = newNotebook();
    n.source = new Uint8Array([0, 127, 128, 255]);
    n.pages[0].strokes = [s];
    expect(decodeProject(encodeProject(n))).toEqual(n);
  });
  it('拒绝格式损坏与不完整工程', () => {
    expect(() => decodeProject('{"version":1,"name":"x","pages":[]}')).toThrow();
    const n = newNotebook();
    n.pages[0].sourceIndex = 0;
    expect(() => decodeProject(encodeProject(n))).toThrow('原始 PDF');
  });
  it('文本框工程保留可编辑内容和样式，拒绝异常字号', () => {
    const notebook = newNotebook();
    notebook.pages[0].images = [
      {
        id: 'text',
        kind: 'text',
        data: 'data:image/png;base64,AA==',
        x: 10,
        y: 20,
        width: 200,
        height: 60,
        textBox: { content: 'Hello\n中文', fontSize: 18, color: '#123456', bold: true },
      },
    ];
    expect(decodeProject(encodeProject(notebook))).toEqual(notebook);
    notebook.pages[0].images[0].textBox!.fontSize = Infinity;
    expect(() => decodeProject(encodeProject(notebook))).toThrow();
  });
  it('图片工程往返保留原色类型，并识别旧版无场景图片', () => {
    const n = newNotebook();
    const image = {
      id: 'picture',
      kind: 'image' as const,
      data: 'data:image/png;base64,AA==',
      x: 1,
      y: 2,
      width: 30,
      height: 40,
    };
    n.pages[0].images = [image];
    expect(decodeProject(encodeProject(n)).pages[0].images).toEqual([image]);
    expect(isPicture(image)).toBe(true);
    expect(isPicture({ ...image, kind: 'sketch' })).toBe(true);
    expect(isPicture({ ...image, kind: 'sketch', scene: { elements: [] } })).toBe(false);
    expect(isPicture({ ...image, kind: 'formula' })).toBe(false);
  });
});
