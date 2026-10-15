import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { TextBox } from './model';
import TextMarkdown from './TextMarkdown';
import { sanitizeSvg, svgImage, type ImportedImage } from './svgImport';
/** Project the browser's formatted text layout to SVG text, preserving sharp zoom. */
export async function markdownTextImage(box: TextBox): Promise<ImportedImage> {
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '840px',
    padding: '16px',
    boxSizing: 'content-box',
    pointerEvents: 'none',
    visibility: 'hidden',
  });
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  const root = createRoot(host);
  const namespace = 'http://www.w3.org/2000/svg';
  try {
    flushSync(() => root.render(<TextMarkdown box={{ ...box, fontSize: box.fontSize * 2 }} />));
    await document.fonts.ready;
    const origin = host.getBoundingClientRect(),
      width = Math.ceil(origin.width),
      height = Math.ceil(host.scrollHeight);
    if (height > 8100 || width * height > 8_000_000) throw Error('text-large');
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const append = (tag: string, values: Record<string, string | number>, content?: string) => {
      const element = document.createElementNS(namespace, tag);
      for (const [key, value] of Object.entries(values)) element.setAttribute(key, String(value));
      if (content !== undefined) element.textContent = content;
      svg.append(element);
    };
    for (const element of host.querySelectorAll('pre,td,th,blockquote,hr')) {
      const r = element.getBoundingClientRect(),
        style = getComputedStyle(element);
      if (element.tagName === 'PRE')
        append('rect', {
          x: r.left - origin.left,
          y: r.top - origin.top,
          width: r.width,
          height: r.height,
          fill: '#8799b3',
          opacity: 0.1,
          rx: 5,
        });
      else if (element.tagName === 'BLOCKQUOTE' || element.tagName === 'HR')
        append('line', {
          x1: r.left - origin.left,
          y1: r.top - origin.top,
          x2: element.tagName === 'HR' ? r.right - origin.left : r.left - origin.left,
          y2: element.tagName === 'HR' ? r.top - origin.top : r.bottom - origin.top,
          stroke: box.color,
          'stroke-width': element.tagName === 'HR' ? 1 : 3,
        });
      else
        append('rect', {
          x: r.left - origin.left,
          y: r.top - origin.top,
          width: r.width,
          height: r.height,
          fill: 'none',
          stroke: style.borderTopColor,
          'stroke-width': 1,
        });
    }
    const measure = document.createElement('canvas').getContext('2d')!;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '',
        parent = node.parentElement!;
      const style = getComputedStyle(parent),
        size = parseFloat(style.fontSize);
      measure.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
      const descent = measure.measureText('Mg').fontBoundingBoxDescent ?? size * 0.2;
      const range = document.createRange();
      let run = '',
        first: DOMRect | undefined,
        last: DOMRect | undefined,
        offset = 0;
      const emit = () => {
        if (!first || !last || !run.trim()) {
          run = '';
          first = last = undefined;
          return;
        }
        append(
          'text',
          {
            x: first.left - origin.left,
            y: first.bottom - origin.top - descent,
            fill: style.color,
            'font-size': size,
            'font-family': style.fontFamily,
            'font-weight': style.fontWeight,
            'font-style': style.fontStyle,
            style: 'white-space:pre',
            textLength: Math.max(0.1, last.right - first.left),
            lengthAdjust: 'spacingAndGlyphs',
            ...(parent.closest('del')
              ? { 'text-decoration': 'line-through' }
              : parent.closest('.markdown-link')
                ? { 'text-decoration': 'underline' }
                : {}),
          },
          run,
        );
        run = '';
        first = last = undefined;
      };
      for (const char of text) {
        range.setStart(node, offset);
        offset += char.length;
        range.setEnd(node, offset);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          if (char === '\n') emit();
          continue;
        }
        if (
          last &&
          (Math.abs(last.top - rect.top) > 0.5 ||
            rect.left - last.right > size * 0.7 ||
            rect.left < last.left)
        )
          emit();
        first ??= rect;
        last = rect;
        run += char;
      }
      emit();
    }
    for (const li of host.querySelectorAll('li')) {
      const r = li.getBoundingClientRect(),
        style = getComputedStyle(li),
        size = parseFloat(style.fontSize);
      const parent = li.parentElement!,
        number =
          Array.from(parent.children).indexOf(li) + (Number(parent.getAttribute('start')) || 1);
      append(
        'text',
        {
          x: r.left - origin.left - size * 0.3,
          y: r.top - origin.top + size,
          fill: style.color,
          'font-size': size,
          'font-family': style.fontFamily,
          'text-anchor': 'end',
        },
        parent.tagName === 'OL' ? `${number}.` : '•',
      );
    }
    const image = await svgImage(sanitizeSvg(new XMLSerializer().serializeToString(svg)));
    return { ...image, textBox: { ...box } };
  } finally {
    root.unmount();
    host.remove();
  }
}
