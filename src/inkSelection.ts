import { inkBounds } from './ink';
import { uid, validNotebook, type Page, type Stroke } from './model';
import type { Bounds } from './spatialIndex';
export type InkGesturePhase = 'start' | 'move' | 'end' | 'cancel';
type Gesture = (phase: InkGesturePhase, x: number, y: number) => void;
const gestures = new Map<string, Gesture>();
export function registerInkGesture(pageId: string, handler: Gesture) {
  gestures.set(pageId, handler);
  return () => {
    if (gestures.get(pageId) === handler) gestures.delete(pageId);
  };
}
export function inkGesture(pageId: string, phase: InkGesturePhase, x: number, y: number) {
  gestures.get(pageId)?.(phase, x, y);
}
export const drawingTool = (tool: string) =>
  ['pen', 'ballpoint', 'pencil', 'highlighter'].includes(tool);
const empty: string[] = [];
let selection: { pageId: string; ids: string[] } | null = null;
const subscribers = new Set<() => void>();
export function selectInk(pageId: string, ids: string[]) {
  if (!ids.length && selection?.pageId !== pageId) return;
  selection = ids.length ? { pageId, ids } : null;
  subscribers.forEach((fn) => fn());
}
export const selectedInk = (pageId: string) =>
  selection?.pageId === pageId ? selection.ids : empty;
export function subscribeInk(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
export function inkBox(strokes: readonly Stroke[]): Bounds | null {
  if (!strokes.length) return null;
  const result = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const stroke of strokes) {
    const b = inkBounds(stroke);
    result.minX = Math.min(result.minX, b.minX);
    result.minY = Math.min(result.minY, b.minY);
    result.maxX = Math.max(result.maxX, b.maxX);
    result.maxY = Math.max(result.maxY, b.maxY);
  }
  return result;
}
/** Select whole strokes intersecting the frame, including a segment crossing
 * it with both endpoints outside. Geometry/pressure stays editable. */
export function strokeInBox(stroke: Stroke, box: Bounds) {
  const pad = stroke.size / 2;
  const b = {
    minX: box.minX - pad,
    minY: box.minY - pad,
    maxX: box.maxX + pad,
    maxY: box.maxY + pad,
  };
  const inside = (x: number, y: number) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  if (stroke.points.some(([x, y]) => inside(x, y))) return true;
  for (let i = 1; i < stroke.points.length; i++) {
    const [x, y] = stroke.points[i - 1],
      [xx, yy] = stroke.points[i];
    let enter = 0,
      leave = 1;
    for (const [p, q] of [
      [x - xx, x - b.minX],
      [xx - x, b.maxX - x],
      [y - yy, y - b.minY],
      [yy - y, b.maxY - y],
    ]) {
      if (p === 0) {
        if (q < 0) {
          leave = -1;
          break;
        }
      } else if (p < 0) enter = Math.max(enter, q / p);
      else leave = Math.min(leave, q / p);
    }
    if (enter <= leave) return true;
  }
  return false;
}
export function translateInk(
  strokes: readonly Stroke[],
  dx: number,
  dy: number,
  fresh = false,
  scale = 1,
) {
  return strokes.map((s) => ({
    ...s,
    id: fresh ? uid() : s.id,
    size: s.size * scale,
    points: s.points.map(
      ([x, y, pressure]) => [x * scale + dx, y * scale + dy, pressure] as [number, number, number],
    ),
  }));
}
export const INK_MIME = 'application/x-tixtab-ink+json';
export type InkClipboard = { type: 'tixtab-ink'; version: 1; pageId: string; strokes: Stroke[] };
export function decodeInk(raw: string): InkClipboard | null {
  if (!raw || raw.length > 50_000_000) return null;
  try {
    const value = JSON.parse(raw) as InkClipboard;
    if (
      value.type !== 'tixtab-ink' ||
      value.version !== 1 ||
      typeof value.pageId !== 'string' ||
      !Array.isArray(value.strokes) ||
      !value.strokes.length ||
      value.strokes.length > 10000 ||
      value.strokes.some(
        (s) =>
          typeof s?.id !== 'string' ||
          !Array.isArray(s.points) ||
          s.points.length > 100000 ||
          s.points.some((p) => p.some((v) => Math.abs(v) > 100000)),
      ) ||
      new Set(value.strokes.map((s) => s.id)).size !== value.strokes.length
    )
      return null;
    return validNotebook({
      version: 1,
      name: 'clipboard',
      source: null,
      pages: [
        {
          id: 'clipboard',
          sourceIndex: null,
          width: 600,
          height: 900,
          paper: 'plain',
          images: [],
          strokes: value.strokes,
        },
      ],
    })
      ? value
      : null;
  } catch {
    return null;
  }
}
export function inkFromClipboard(data: Pick<DataTransfer, 'getData'>) {
  const direct = decodeInk(data.getData(INK_MIME));
  if (direct) return direct;
  const html = data.getData('text/html');
  if (html.length > 100_000_000) return null;
  const attribute = html.match(/\bdata-tixtab-ink\s*=\s*("[^"]*"|'[^']*')/i);
  if (!attribute) return null;
  const raw = new DOMParser()
    .parseFromString(`<span data-tixtab-ink=${attribute[1]}></span>`, 'text/html')
    .querySelector('[data-tixtab-ink]')
    ?.getAttribute('data-tixtab-ink');
  return raw ? decodeInk(raw) : null;
}
export async function copyInk(page: Page, ids: readonly string[]) {
  const chosen = new Set(ids);
  const raw = JSON.stringify({
    type: 'tixtab-ink',
    version: 1,
    pageId: page.id,
    strokes: page.strokes.filter((s) => chosen.has(s.id)),
  } satisfies InkClipboard);
  if (!decodeInk(raw)) throw new Error('Invalid ink selection');
  const escape = (s: string) =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  const text = '[TixTab ink]';
  const html = `<span data-tixtab-ink="${escape(raw)}">${text}</span>`;
  let written = false;
  const copy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData(INK_MIME, raw);
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', text);
    written = true;
  };
  document.addEventListener('copy', copy, true);
  try {
    if (document.execCommand('copy') && written) return;
  } finally {
    document.removeEventListener('copy', copy, true);
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    }),
  ]);
}
export async function pasteInkFromButton() {
  const data = new DataTransfer();
  for (const item of await navigator.clipboard.read())
    for (const type of ['text/html', 'text/plain'])
      if (item.types.includes(type)) data.setData(type, await (await item.getType(type)).text());
  if (!inkFromClipboard(data)) throw new Error('No editable ink');
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
}
export function placeInk(
  payload: InkClipboard,
  page: Page,
  anchor?: { pageId?: string; x?: number; y?: number },
) {
  const box = inkBox(payload.strokes)!;
  const width = Math.max(1, box.maxX - box.minX),
    height = Math.max(1, box.maxY - box.minY);
  const scale = Math.min(1, (page.width * 0.9) / width, (page.height * 0.9) / height);
  const x = Math.max(
    0,
    Math.min(
      page.width - width * scale,
      anchor?.x !== undefined
        ? anchor.x - (width * scale) / 2 + 16
        : payload.pageId === page.id
          ? box.minX + 16
          : (page.width - width * scale) / 2,
    ),
  );
  const y = Math.max(
    0,
    Math.min(
      page.height - height * scale,
      anchor?.y !== undefined
        ? anchor.y - (height * scale) / 2 + 16
        : payload.pageId === page.id
          ? box.minY + 16
          : (page.height - height * scale) / 2,
    ),
  );
  return translateInk(payload.strokes, x - box.minX * scale, y - box.minY * scale, true, scale);
}
