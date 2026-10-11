import { describe, expect, it } from 'vitest';
import { normalizeTranslationText } from './translationText';
import { PanZoomPointers } from './gestures';
import { parseMacros } from './latexMacros';
describe('跨行翻译和视图交互', () => {
  it('合并 PDF 软换行并保留空行段落、中日韩连续文字', () => {
    expect(normalizeTranslationText('The book is on\r\n  the table.\n \nNext paragraph.')).toBe(
      'The book is on the table.\n\nNext paragraph.',
    );
    expect(normalizeTranslationText('中文换行\n继续阅读\n第三行。')).toBe(
      '中文换行继续阅读第三行。',
    );
    expect(normalizeTranslationText('trans\u00ad\nlation')).toBe('translation');
  });
  it.each([
    [0, 80],
    [80, 0],
    [60, 60],
  ])('双指朝向 %s,%s 平移不改变缩放', (x, y) => {
    const p = new PanZoomPointers();
    p.down(1, 100, 100);
    p.down(2, 100 + x, 100 + y);
    p.move(1, 200, 125);
    p.move(2, 200 + x, 125 + y);
    expect(p.take()).toMatchObject({ dx: 100, dy: 25, scale: 1 });
    p.up(1);
    p.move(2, 210 + x, 145 + y);
    expect(p.take()).toMatchObject({ dx: 10, dy: 20, scale: 1 });
  });
  it('捏合由真实两指距离决定，第三指不参与变换', () => {
    const p = new PanZoomPointers();
    p.down(1, 100, 100);
    p.down(2, 200, 100);
    p.move(1, 50, 100);
    p.move(2, 250, 100);
    expect(p.take()).toMatchObject({ dx: 0, dy: 0, scale: 2 });
    p.down(3, 300, 100);
    expect(p.take()).toBeNull();
  });
  it('预定义命令支持参数，拒绝错误格式', () => {
    expect(parseMacros('{"\\\\RR":"\\\\mathbb{R}","\\\\vect":"\\\\mathbf{#1}"}')).toEqual({
      '\\RR': '\\mathbb{R}',
      '\\vect': '\\mathbf{#1}',
    });
    expect(() => parseMacros('{"RR":1}')).toThrow();
    expect(
      parseMacros('\\newcommand{\\RR}{\\mathbb{R}}\n\\newcommand{\\vect}[1]{\\mathbf{#1}}'),
    ).toEqual({ '\\RR': '\\mathbb{R}', '\\vect': '\\mathbf{#1}' });
    expect(() => parseMacros('\\newcommand{\\RR}{\\mathbb{R}')).toThrow();
  });
});
