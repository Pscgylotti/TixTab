import { validTextBox, type TextBox } from './model';
import { sanitizeSvg, svgImage, type ImportedImage } from './svgImport';

export const defaultTextBox: TextBox = { content: '', fontSize: 18, color: '#23324d', bold: false };
const namespace = 'http://www.w3.org/2000/svg';
/** Vector preview, with a bounded PNG for the existing background PDF exporter. */
export async function textBoxImage(box: TextBox): Promise<ImportedImage> {
  if (!validTextBox(box) || !box.content.trim()) throw Error('text-invalid');
  const fontSize = box.fontSize * 2,
    padding = 16,
    maxWidth = 840;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font = `${box.bold ? 600 : 400} ${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  const lines: string[] = [];
  const lineHeight = fontSize * 1.4;
  const push = (line: string) => {
    lines.push(line);
    if (lines.length * lineHeight + padding * 2 > 8100) throw Error('text-large');
  };
  for (const paragraph of box.content.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = '';
    for (const word of paragraph.match(/\s+|\S+/gu) || []) {
      if (context.measureText(line + word).width <= maxWidth) {
        line += word;
        continue;
      }
      if (line) {
        push(line);
        line = '';
      }
      if (context.measureText(word).width <= maxWidth) {
        line = word;
        continue;
      }
      for (const char of word) {
        if (line && context.measureText(line + char).width > maxWidth) {
          push(line);
          line = '';
        }
        line += char;
      }
    }
    push(line);
  }
  const width =
    Math.max(160, ...lines.map((line) => context.measureText(line).width)) + padding * 2;
  const height = lines.length * lineHeight + padding * 2;
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('xmlns', namespace);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  for (const [index, line] of lines.entries()) {
    const text = document.createElementNS(namespace, 'text');
    text.setAttribute('x', String(padding));
    text.setAttribute('y', String(padding + fontSize + index * lineHeight));
    text.setAttribute('font-size', String(fontSize));
    text.setAttribute('font-family', 'Segoe UI, Microsoft YaHei, sans-serif');
    text.setAttribute('font-weight', box.bold ? '600' : '400');
    text.setAttribute('fill', box.color);
    text.setAttribute('style', 'white-space:pre');
    text.textContent = line;
    svg.append(text);
  }
  const image = await svgImage(sanitizeSvg(new XMLSerializer().serializeToString(svg)));
  return { ...image, textBox: { ...box } };
}
