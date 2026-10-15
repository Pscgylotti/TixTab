import type { TextContent } from './pdfTextContent';
import { pdfTextQuad, textRunGap } from './pdfTextGeometry';

/** Build selectable DOM only for visible selection layers. No font/image
 * loading, global canvas, observers or retained document references. */
export function renderPdfTextDom(
  root: HTMLElement,
  content: TextContent,
  viewport: {
    width: number;
    height: number;
    transform: number[];
    scale: number;
    userUnit?: number;
  },
) {
  root.replaceChildren();
  root.style.width = `${viewport.width}px`;
  root.style.height = `${viewport.height}px`;
  const fragment = document.createDocumentFragment();
  const runs: { span: HTMLSpanElement; width: number; transform: string }[] = [];
  let previous: { span: HTMLSpanElement; quad: number[]; last: string } | undefined;
  const separator = (text: string) => {
    if (!previous || !text) return;
    let child = previous.span.querySelector<HTMLElement>('.pdf-text-separator');
    if (!child) {
      child = document.createElement('span');
      child.className = 'pdf-text-separator';
      child.style.cssText = 'left:100%;top:0;font-size:inherit;transform:none;pointer-events:none';
      previous.span.append(child);
    }
    child.append(document.createTextNode(text));
    previous.last += text;
  };
  for (const item of content.items) {
    if (!('str' in item)) continue;
    if (!item.str.trim()) {
      separator(item.str + (item.hasEOL ? '\n' : ''));
      continue;
    }
    const style = content.styles[item.fontName],
      quad = pdfTextQuad(item, style, viewport),
      dx = quad[2] - quad[0],
      dy = quad[3] - quad[1],
      ux = quad[6] - quad[0],
      uy = quad[7] - quad[1],
      width = Math.hypot(dx, dy),
      height = Math.hypot(ux, uy);
    if (!(width > 0 && height > 0)) continue;
    if (
      previous &&
      !/\s$/.test(previous.last) &&
      !/^\s/.test(item.str) &&
      textRunGap(previous.quad, quad)
    )
      separator(' ');
    const span = document.createElement('span'),
      fontSize = Math.max(1, height),
      scale = height / fontSize,
      transform = `matrix(${(dx / width) * scale},${(dy / width) * scale},${(ux / height) * scale},${(uy / height) * scale},0,0)`;
    span.className = 'pdf-text-run';
    span.textContent = item.str;
    span.dir = item.dir;
    span.style.left = `${quad[0]}px`;
    span.style.top = `${quad[1]}px`;
    span.style.fontSize = `${fontSize}px`;
    span.style.fontFamily = style?.fontFamily || 'sans-serif';
    span.style.setProperty('--rotate', `${(Math.atan2(dy, dx) * 180) / Math.PI}deg`);
    // Keep untransformed fractional widths for one batched DOM measurement.
    span.style.transform = 'none';
    fragment.append(span);
    runs.push({ span, width: width / scale, transform });
    previous = { span, quad, last: item.str };
    if (item.hasEOL) separator('\n');
  }
  root.append(fragment);
  const measured = runs.map(({ span }) => parseFloat(getComputedStyle(span).width));
  runs.forEach(({ span, width, transform }, i) => {
    span.style.transform = `${transform} scaleX(${measured[i] > 0 ? width / measured[i] : 1})`;
  });
}
