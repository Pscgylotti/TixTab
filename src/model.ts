export type Tool =
  'pen' | 'ballpoint' | 'pencil' | 'highlighter' | 'eraser' | 'hand' | 'select' | 'object';
export type Point = [number, number, number];
export interface Stroke {
  id: string;
  tool: Tool;
  color: string;
  size: number;
  points: Point[];
}
export interface PlacedImage {
  id: string;
  data: string;
  displayData?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'sketch' | 'formula' | 'image' | 'text';
  textBox?: TextBox;
  latex?: string;
  macros?: Record<string, string>;
  scene?: Record<string, unknown>;
}
export interface TextBox {
  content: string;
  fontSize: number;
  color: string;
  bold: boolean;
}
export function validTextBox(value: unknown): value is TextBox {
  if (!value || typeof value !== 'object') return false;
  const box = value as TextBox;
  return (
    typeof box.content === 'string' &&
    box.content.length <= 10_000 &&
    Number.isFinite(box.fontSize) &&
    box.fontSize >= 8 &&
    box.fontSize <= 72 &&
    /^#[0-9a-f]{6}$/i.test(box.color) &&
    typeof box.bold === 'boolean'
  );
}
/** Older imported pictures used the sketch kind without an editable scene. */
export function isPicture(image: PlacedImage) {
  return image.kind === 'image' || (image.kind === 'sketch' && !image.scene);
}
export interface Page {
  id: string;
  sourceIndex: number | null;
  width: number;
  height: number;
  strokes: Stroke[];
  images: PlacedImage[];
  /** Number of image objects below the page's single handwriting layer. Legacy pages default to top. */
  inkLayer?: number;
  paper: 'plain' | 'dots' | 'lines';
}
import { validZoteroSource, type ZoteroSource } from './zoteroSource';
export interface Notebook {
  version: 1;
  name: string;
  source: Uint8Array | null;
  pages: Page[];
  scene?: Record<string, unknown>;
  zotero?: ZoteroSource;
}
export const uid = () => crypto.randomUUID();
export const blankPage = (width = 595.28, height = 841.89): Page => ({
  id: uid(),
  sourceIndex: null,
  width,
  height,
  strokes: [],
  images: [],
  paper: 'dots',
});
export const newNotebook = (): Notebook => ({
  version: 1,
  name: '未命名笔记',
  source: null,
  pages: [blankPage()],
});
export function isEmptyStarterNotebook(n: Notebook) {
  const p = n.pages[0];
  return (
    n.name === '未命名笔记' &&
    n.source === null &&
    !n.scene &&
    !n.zotero &&
    n.pages.length === 1 &&
    p.sourceIndex === null &&
    p.paper === 'dots' &&
    p.width === 595.28 &&
    p.height === 841.89 &&
    !p.strokes.length &&
    !p.images.length
  );
}
export const isEraser = (e: { pointerType: string; buttons: number; button: number }) =>
  e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5);
export function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function hitStroke(stroke: Stroke, from: Point, to: Point, radius: number) {
  const r = radius + stroke.size / 2;
  return stroke.points.some(
    (p, i, pts) =>
      segmentDistance(p, from, to) <= r ||
      (i > 0 &&
        (segmentDistance(from, pts[i - 1], p) <= r ||
          segmentDistance(to, pts[i - 1], p) <= r ||
          intersects(from, to, pts[i - 1], p))),
  );
}
export function hitImage(image: PlacedImage, from: Point, to: Point, radius: number) {
  const left = image.x - radius,
    right = image.x + image.width + radius,
    top = image.y - radius,
    bottom = image.y + image.height + radius;
  let low = 0,
    high = 1;
  for (const [origin, delta, min, max] of [
    [from[0], to[0] - from[0], left, right],
    [from[1], to[1] - from[1], top, bottom],
  ]) {
    if (delta === 0) {
      if (origin < min || origin > max) return false;
    } else {
      const a = (min - origin) / delta,
        b = (max - origin) / delta;
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
      if (low > high) return false;
    }
  }
  return true;
}
function intersects(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
export function validNotebook(value: unknown): value is Notebook {
  if (!value || typeof value !== 'object') return false;
  const n = value as Notebook;
  if (n.zotero !== undefined && !validZoteroSource(n.zotero)) return false;
  return (
    n.version === 1 &&
    typeof n.name === 'string' &&
    Array.isArray(n.pages) &&
    n.pages.length > 0 &&
    n.pages.length < 10001 &&
    n.pages.every(
      (p) =>
        typeof p.id === 'string' &&
        Number.isFinite(p.width) &&
        p.width > 0 &&
        p.width <= 20000 &&
        Number.isFinite(p.height) &&
        p.height > 0 &&
        p.height <= 20000 &&
        (p.sourceIndex === null || (Number.isInteger(p.sourceIndex) && p.sourceIndex >= 0)) &&
        ['plain', 'dots', 'lines'].includes(p.paper) &&
        Array.isArray(p.strokes) &&
        p.strokes.every(
          (s) =>
            ['pen', 'ballpoint', 'pencil', 'highlighter'].includes(s.tool) &&
            /^#[0-9a-f]{6}$/i.test(s.color) &&
            Number.isFinite(s.size) &&
            s.size > 0 &&
            s.size <= 100 &&
            Array.isArray(s.points) &&
            s.points.length > 0 &&
            s.points.every(
              (pt) => Array.isArray(pt) && pt.length === 3 && pt.every(Number.isFinite),
            ),
        ) &&
        Array.isArray(p.images) &&
        (p.inkLayer === undefined ||
          (Number.isInteger(p.inkLayer) && p.inkLayer >= 0 && p.inkLayer <= p.images.length)) &&
        p.images.every(
          (i) =>
            typeof i.id === 'string' &&
            ['sketch', 'formula', 'image', 'text'].includes(i.kind) &&
            (i.kind !== 'text' || validTextBox(i.textBox)) &&
            (i.macros === undefined || validMacroSnapshot(i.macros)) &&
            (i.displayData === undefined || /^data:image\/svg\+xml;base64,/.test(i.displayData)) &&
            (i.scene === undefined ||
              (i.scene !== null && typeof i.scene === 'object' && !Array.isArray(i.scene))) &&
            /^data:image\/png;base64,/.test(i.data) &&
            [i.x, i.y, i.width, i.height].every(Number.isFinite) &&
            i.width > 0 &&
            i.height > 0,
        ),
    )
  );
}
export function validMacroSnapshot(value: unknown) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 100 &&
    Object.entries(value).every(
      ([key, expansion]) =>
        /^\\[a-zA-Z]+$/.test(key) && typeof expansion === 'string' && expansion.length <= 2000,
    )
  );
}
