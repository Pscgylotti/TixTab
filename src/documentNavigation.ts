import type { PDFDocumentProxy } from './pdfTypes';
import { renderPolicy, subscribeAppearance } from './appearance';
import type { Page, PlacedImage } from './model';
import { readPdfTextContent } from './pdfTextContent';
import { groupLeaves } from './objectGroup';
import { polygonBox } from './pdfNightGeometry';
import { pdfTextQuad, sliceTextQuad, textRunGap } from './pdfTextGeometry';
import { imageCorners } from './objectRotation';
import type { OcrAnnotation } from './ocrLayout';
export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SearchHit {
  pageId: string;
  text: string;
  rects: TextRect[];
  key: string;
  context?: string;
}
interface TextPart {
  start: number;
  end: number;
  rect: TextRect;
  quad?: number[];
  whole?: boolean;
}
export interface PageText {
  text: string;
  parts: TextPart[];
}
interface Cache {
  text: Map<number, Promise<PageText>>;
  weights: Map<number, number>;
  destinations: Map<string, Promise<number | null>>;
}
let documents = new WeakMap<PDFDocumentProxy, Cache>();
subscribeAppearance(() => {
  if (renderPolicy().minimal) documents = new WeakMap();
});
function cacheFor(pdf: PDFDocumentProxy) {
  let value = documents.get(pdf);
  if (!value)
    documents.set(pdf, (value = { text: new Map(), weights: new Map(), destinations: new Map() }));
  return value;
}
/** Shared by search and visible URL detection. No raster or text-layer DOM is created. */
export function readPageText(pdf: PDFDocumentProxy, sourceIndex: number) {
  const owner = cacheFor(pdf),
    cache = owner.text;
  let request = cache.get(sourceIndex);
  if (request) {
    cache.delete(sourceIndex);
    cache.set(sourceIndex, request);
    return request;
  }
  request = (async () => {
    const page = await pdf.getPage(sourceIndex + 1),
      viewport = page.getViewport({ scale: 1 }),
      content = await readPdfTextContent(pdf, sourceIndex, page);
    const parts: TextPart[] = [];
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const quad = pdfTextQuad(item, content.styles[item.fontName], viewport),
        rect = polygonBox(quad),
        previous = parts.at(-1)?.quad;
      if (previous && !/\s$/.test(text) && !/^\s/.test(item.str) && textRunGap(previous, quad))
        text += ' ';
      parts.push({ start: text.length, end: text.length + item.str.length, rect, quad });
      text += item.str + (item.hasEOL ? '\n' : '');
    }
    if (cache.get(sourceIndex) === request) {
      owner.weights.set(sourceIndex, text.length * 2 + parts.length * 160);
      let retained = [...owner.weights.values()].reduce((a, b) => a + b, 0);
      while (retained > (renderPolicy().minimal ? 256000 : 8_000_000) && cache.size) {
        const oldest = cache.keys().next().value!;
        retained -= owner.weights.get(oldest) ?? 0;
        cache.delete(oldest);
        owner.weights.delete(oldest);
      }
    }
    return { text, parts };
  })();
  cache.set(sourceIndex, request);
  // Bound retained page structures; evicted pages are rebuilt only on demand.
  if (cache.size > (renderPolicy().minimal ? 2 : 128)) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
    owner.weights.delete(oldest);
  }
  void request.catch(() => {
    if (cache.get(sourceIndex) === request) cache.delete(sourceIndex);
  });
  return request;
}
export function safeDocumentUrl(value: string) {
  try {
    const url = new URL(/^www\./i.test(value) ? `https://${value}` : value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function openDocumentUrl(event: { preventDefault: () => void }, value: string) {
  const url = safeDocumentUrl(value);
  if (!url) {
    event.preventDefault();
    return;
  }
  if (window.surfaceDesktop?.openDocumentUrl) {
    event.preventDefault();
    void window.surfaceDesktop.openDocumentUrl(url);
  }
}
export function detectedUrls(content: PageText) {
  const found: { start: number; end: number; url: string }[] = [];
  const add = (start: number, end: number, value: string) => {
    const url = safeDocumentUrl(value);
    if (url && !found.some((old) => start < old.end && end > old.start))
      found.push({ start, end, url });
  };
  for (const match of content.text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"\u3000]+/gi)) {
    const value = match[0].replace(/[.,;:!?，。；！？”’）\])}]+$/, ''),
      start = match.index!;
    add(start, start + value.length, value);
  }
  // Require the explicit prefix: an ordinary decimal must not become a paper link.
  for (const match of content.text.matchAll(
    /\barxiv\s*:\s*((?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?)(?!\w|\.\d)/gi,
  ))
    add(
      match.index!,
      match.index! + match[0].length,
      `https://arxiv.org/abs/${match[1].toLowerCase()}`,
    );
  for (const match of content.text.matchAll(
    /(?:mailto:)?[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\b/gi,
  )) {
    const start = match.index!;
    if (start && /[\w@]/.test(content.text[start - 1])) continue;
    add(start, start + match[0].length, `mailto:${match[0].replace(/^mailto:/i, '')}`);
  }
  return found
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, url }) => ({
      url,
      rects: textRects(content, start, end),
    }));
}
function textRects(content: PageText, start: number, end: number) {
  return content.parts
    .filter((p) => p.end > start && p.start < end)
    .map((p) => {
      if (p.whole) return p.rect;
      const count = Math.max(1, p.end - p.start),
        left = Math.max(start, p.start) - p.start,
        right = Math.min(end, p.end) - p.start;
      if (p.quad) return polygonBox(sliceTextQuad(p.quad, left / count, right / count));
      return {
        ...p.rect,
        x: p.rect.x + (p.rect.width * left) / count,
        width: (p.rect.width * (right - left)) / count,
      };
    });
}
export function findText(
  content: PageText,
  query: string,
  pageId: string,
  prefix = 'pdf',
): SearchHit[] {
  // Keep offsets in the original string (case-folding some Unicode expands its length).
  const expression = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
    'giu',
  );
  const matches: SearchHit[] = [];
  for (const match of content.text.matchAll(expression)) {
    const start = match.index!,
      end = start + match[0].length;
    let contextStart = start,
      contextEnd = end;
    for (let i = 0; i < 2; i++) {
      const previous = content.text.lastIndexOf('\n', contextStart - 1);
      contextStart = previous < 0 ? 0 : previous;
    }
    for (let i = 0; i < 3; i++) {
      const next = content.text.indexOf('\n', contextEnd + 1);
      contextEnd = next < 0 ? content.text.length : next;
    }
    contextStart = Math.max(contextStart, start - 1000);
    contextEnd = Math.min(contextEnd, end + 1000);
    matches.push({
      pageId,
      key: `${pageId}:${prefix}:${start}`,
      text: `${start > 20 ? '... ' : ''}${content.text.slice(Math.max(0, start - 20), end + 45).replace(/\s+/g, ' ')}${end + 45 < content.text.length ? ' ...' : ''}`,
      context: content.text.slice(contextStart, contextEnd).trim(),
      rects: textRects(content, start, end),
    });
    if (matches.length >= 200) break;
  }
  return matches;
}
const objectTexts = new WeakMap<PlacedImage, string>();
export function objectText(image: PlacedImage): string {
  let text = objectTexts.get(image);
  if (text === undefined) {
    text = image.group
      ? image.group.objects.map(objectText).join('\n')
      : (image.textBox?.content ?? image.latex ?? '');
    objectTexts.set(image, text);
  }
  return text;
}
export function findObjectText(page: Page, query: string) {
  return page.images.flatMap((image) => {
    const text = objectText(image);
    return findText(
      {
        text,
        parts: [
          {
            start: 0,
            end: text.length,
            rect: { x: image.x, y: image.y, width: image.width, height: image.height },
          },
        ],
      },
      query,
      page.id,
      image.id,
    );
  });
}
/** OCR lines use measured whole-line bounds, never guessed character widths. */
export function findBitmapText(page: Page, query: string) {
  const hits: SearchHit[] = [];
  const add = (ocr: OcrAnnotation, polygon: number[], key: string, pdf = false) => {
    const map = (u: number, v: number): number[] => {
      const origin = pdf ? 6 : 0,
        right = pdf ? 4 : 2,
        down = pdf ? 0 : 6;
      return [
        polygon[origin] +
          u * (polygon[right] - polygon[origin]) +
          v * (polygon[down] - polygon[origin]),
        polygon[origin + 1] +
          u * (polygon[right + 1] - polygon[origin + 1]) +
          v * (polygon[down + 1] - polygon[origin + 1]),
      ];
    };
    let text = '';
    const parts: TextPart[] = [];
    for (const line of ocr.lines) {
      const start = text.length;
      text += line.text + '\n';
      const projected = line.polygon.flatMap((n, i) => (i % 2 ? [] : map(n, line.polygon[i + 1])));
      parts.push({ start, end: text.length - 1, rect: polygonBox(projected), whole: true });
    }
    if (!ocr.lines.length) {
      text = ocr.text;
      parts.push({ start: 0, end: text.length, rect: polygonBox(polygon), whole: true });
    }
    hits.push(...findText({ text, parts }, query, page.id, `ocr:${key}`));
  };
  for (const b of page.bitmapOcr ?? []) add(b.result, b.polygon, `pdf:${b.imageIndex}`, true);
  for (const image of page.images.flatMap(groupLeaves))
    if (image.ocr) add(image.ocr, imageCorners(image), image.id);
  return hits;
}
export async function resolveDestination(pdf: PDFDocumentProxy, destination: unknown) {
  let dest = destination;
  if (typeof dest === 'string') dest = await pdf.getDestination(dest);
  if (!Array.isArray(dest) || !dest.length) return null;
  const ref = dest[0];
  let sourceIndex: number | null;
  if (Number.isInteger(ref)) sourceIndex = ref;
  else if (ref && Number.isInteger(ref.num) && Number.isInteger(ref.gen)) {
    const cache = cacheFor(pdf).destinations,
      key = `${ref.num}:${ref.gen}`;
    let request = cache.get(key);
    if (!request) {
      request = pdf.getPageIndex(ref).catch(() => null);
      cache.set(key, request);
    }
    sourceIndex = await request;
  } else return null;
  if (sourceIndex === null || sourceIndex < 0 || sourceIndex >= pdf.numPages) return null;
  const page = await pdf.getPage(sourceIndex + 1),
    viewport = page.getViewport({ scale: 1 });
  let rect: TextRect | undefined;
  if (dest[1]?.name === 'XYZ' && typeof dest[3] === 'number') {
    const [x, y] = viewport.convertToViewportPoint(
      typeof dest[2] === 'number' ? dest[2] : page.view[0],
      dest[3],
    );
    rect = { x, y, width: 1, height: 20 };
  } else if (['FitH', 'FitBH'].includes(dest[1]?.name) && typeof dest[2] === 'number') {
    const [x, y] = viewport.convertToViewportPoint(page.view[0], dest[2]);
    rect = { x, y, width: 1, height: 20 };
  }
  return { sourceIndex, rect };
}
