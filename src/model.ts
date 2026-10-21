import type { ScratchPaper } from './scratchPaper';
import { validOcr, type OcrAnnotation } from './ocrLayout';
import { validNativeEdits, type NativePdfEdit } from './pdfNativeTypes';
import { validMusicScore, type MusicScore } from './musicScore';
export type Tool =
  | 'pen'
  | 'ballpoint'
  | 'pencil'
  | 'highlighter'
  | 'eraser'
  | 'hand'
  | 'select'
  | 'object'
  | 'pdf-edit'
  | 'review';
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
  rotation?: 0 | 90 | 180 | 270;
  textBox?: TextBox;
  latex?: string;
  macros?: Record<string, string>;
  scene?: Record<string, unknown>;
  ocr?: OcrAnnotation;
  /** A detached page snapshot on scratch paper; intentionally cannot be copied. */
  scratchPage?: boolean;
  /** Display-only night version of a detached PDF snapshot; original pixels remain in data. */
  nightData?: string;
  crop?: {
    original: string;
    nightOriginal?: string;
    rect: { x: number; y: number; width: number; height: number };
  };
  colorKey?: { original: string; color: string; tolerance: number };
  correction?: { model: string; sourceImageIndex?: number };
  /** Immediate editable children in local coordinates; groups may contain other groups. */
  group?: { width: number; height: number; objects: PlacedImage[] };
}
export interface TextBox {
  format?: 'plain' | 'markdown';
  content: string;
  fontSize: number;
  color: string;
  bold: boolean;
}
export function validTextBox(value: unknown): value is TextBox {
  if (!value || typeof value !== 'object') return false;
  const box = value as TextBox;
  return (
    (box.format === undefined || ['plain', 'markdown'].includes(box.format)) &&
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
export interface ReviewNote {
  id: string;
  text: string;
  region: { x: number; y: number; width: number; height: number };
  /** Screen-pixel offset of the side card, independent of page zoom. */
  cardOffset?: { x: number; y: number };
}
export function validReviews(value: unknown): value is ReviewNote[] {
  return (
    Array.isArray(value) &&
    value.length <= 4096 &&
    value.every(
      (n) =>
        n &&
        typeof n.id === 'string' &&
        typeof n.text === 'string' &&
        n.text.length <= 10000 &&
        n.region &&
        ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(n.region[k])) &&
        n.region.width > 0 &&
        n.region.height > 0 &&
        (n.cardOffset === undefined ||
          (n.cardOffset &&
            ['x', 'y'].every(
              (key) => Number.isFinite(n.cardOffset[key]) && Math.abs(n.cardOffset[key]) <= 1000000,
            ))),
    )
  );
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
  paper: 'plain' | 'dots' | 'grid' | 'lines' | 'fine-grid';
  paperColor?: string;
  reviews?: ReviewNote[];
  /** Revision changes native content without losing stable notebook page identity. */
  nativeRevision?: string;
  pdfEdits?: NativePdfEdit[];
  score?: MusicScore;
  /** Nonvisual OCR metadata for source PDF bitmaps, in page coordinates. */
  bitmapOcr?: { imageIndex: number; polygon: number[]; result: OcrAnnotation }[];
}
import { validZoteroSource, type ZoteroSource } from './zoteroSource';
export interface Notebook {
  version: 1;
  name: string;
  source: Uint8Array | null;
  /** Local workspace association; omitted from portable project exports. */
  sourcePath?: string;
  pages: Page[];
  scratchPapers?: ScratchPaper[];
  activeScratchId?: string;
  scene?: Record<string, unknown>;
  zotero?: ZoteroSource;
  bookmarks?: { id: string; pageId: string; title: string }[];
  batch?: { id: string; title: string; itemId: string };
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
    !n.sourcePath &&
    !n.batch &&
    !n.bookmarks?.length &&
    !n.scene &&
    !n.scratchPapers?.length &&
    !n.zotero &&
    n.pages.length === 1 &&
    p.sourceIndex === null &&
    p.paper === 'dots' &&
    p.paperColor === undefined &&
    p.width === 595.28 &&
    p.height === 841.89 &&
    !p.strokes.length &&
    !p.images.length &&
    !p.reviews?.length &&
    !p.pdfEdits?.length &&
    !p.bitmapOcr?.length &&
    !p.score
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
  if (
    n.batch !== undefined &&
    (!n.batch ||
      typeof n.batch.id !== 'string' ||
      n.batch.id.length > 128 ||
      typeof n.batch.itemId !== 'string' ||
      n.batch.itemId.length > 128 ||
      typeof n.batch.title !== 'string' ||
      n.batch.title.length > 512)
  )
    return false;
  if (
    n.bookmarks !== undefined &&
    (!Array.isArray(n.bookmarks) ||
      n.bookmarks.length > 10000 ||
      !n.bookmarks.every(
        (b) =>
          b &&
          typeof b.id === 'string' &&
          typeof b.pageId === 'string' &&
          typeof b.title === 'string' &&
          b.title.length <= 200,
      ))
  )
    return false;
  if (n.zotero !== undefined && !validZoteroSource(n.zotero)) return false;
  if (
    n.sourcePath !== undefined &&
    (typeof n.sourcePath !== 'string' || n.sourcePath.length > 32767)
  )
    return false;
  if (
    n.scratchPapers !== undefined &&
    (!Array.isArray(n.scratchPapers) ||
      n.scratchPapers.length > 10 ||
      new Set(n.scratchPapers.map((p) => p?.id)).size !== n.scratchPapers.length ||
      n.scratchPapers.some(
        (p) =>
          !p ||
          typeof p.id !== 'string' ||
          typeof p.name !== 'string' ||
          (p.customName !== undefined && typeof p.customName !== 'boolean') ||
          p.name.length > 80 ||
          !p.page ||
          p.page.sourceIndex !== null ||
          !p.view ||
          ![p.view.x, p.view.y, p.view.zoom].every(Number.isFinite) ||
          p.view.zoom < 0.08 ||
          p.view.zoom > 8 ||
          !validNotebook({ version: 1, name: 'scratch', source: null, pages: [p.page] }),
      ))
  )
    return false;
  if (
    n.activeScratchId !== undefined &&
    (typeof n.activeScratchId !== 'string' ||
      !n.scratchPapers?.some((p) => p.id === n.activeScratchId))
  )
    return false;
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
        ['plain', 'dots', 'grid', 'lines', 'fine-grid'].includes(p.paper) &&
        (p.paperColor === undefined || /^#[0-9a-f]{6}$/i.test(p.paperColor)) &&
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
        (p.reviews === undefined || validReviews(p.reviews)) &&
        (p.nativeRevision === undefined || typeof p.nativeRevision === 'string') &&
        (p.pdfEdits === undefined || validNativeEdits(p.pdfEdits)) &&
        (p.score === undefined || validMusicScore(p.score)) &&
        (p.bitmapOcr === undefined ||
          (Array.isArray(p.bitmapOcr) &&
            p.bitmapOcr.length <= 4096 &&
            p.bitmapOcr.every(
              (b) =>
                Number.isInteger(b.imageIndex) &&
                b.imageIndex >= 0 &&
                Array.isArray(b.polygon) &&
                b.polygon.length === 8 &&
                b.polygon.every(Number.isFinite) &&
                validOcr(b.result),
            ))) &&
        (p.inkLayer === undefined ||
          (Number.isInteger(p.inkLayer) && p.inkLayer >= 0 && p.inkLayer <= p.images.length)) &&
        p.images.every(
          (i) =>
            typeof i.id === 'string' &&
            ['sketch', 'formula', 'image', 'text'].includes(i.kind) &&
            (i.scratchPage === undefined || typeof i.scratchPage === 'boolean') &&
            (i.nightData === undefined ||
              (i.scratchPage === true && /^data:image\/png;base64,/.test(i.nightData))) &&
            (i.correction === undefined ||
              (i.correction &&
                typeof i.correction.model === 'string' &&
                i.correction.model.length <= 100 &&
                (i.correction.sourceImageIndex === undefined ||
                  (Number.isInteger(i.correction.sourceImageIndex) &&
                    i.correction.sourceImageIndex >= 0)))) &&
            (i.crop === undefined ||
              (i.crop &&
                typeof i.crop.original === 'string' &&
                /^data:image\/(png|jpeg|webp);base64,/.test(i.crop.original) &&
                (i.crop.nightOriginal === undefined ||
                  /^data:image\/png;base64,/.test(i.crop.nightOriginal)) &&
                i.crop.rect &&
                [i.crop.rect.x, i.crop.rect.y, i.crop.rect.width, i.crop.rect.height].every(
                  Number.isFinite,
                ) &&
                i.crop.rect.x >= 0 &&
                i.crop.rect.y >= 0 &&
                i.crop.rect.width > 0 &&
                i.crop.rect.height > 0 &&
                i.crop.rect.x + i.crop.rect.width <= 1.000001 &&
                i.crop.rect.y + i.crop.rect.height <= 1.000001)) &&
            (i.colorKey === undefined ||
              (i.colorKey &&
                /^data:image\/png;base64,/.test(i.colorKey.original) &&
                /^#[0-9a-f]{6}$/i.test(i.colorKey.color) &&
                Number.isInteger(i.colorKey.tolerance) &&
                i.colorKey.tolerance >= 0 &&
                i.colorKey.tolerance <= 255)) &&
            (i.rotation === undefined || [0, 90, 180, 270].includes(i.rotation)) &&
            (i.kind !== 'text' || validTextBox(i.textBox)) &&
            (i.macros === undefined || validMacroSnapshot(i.macros)) &&
            (i.ocr === undefined || validOcr(i.ocr)) &&
            (i.group === undefined || validObjectGroup(i.group)) &&
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
export const MAX_GROUP_DEPTH = 8;
export const MAX_GROUP_OBJECTS = 1000;
export function validObjectGroup(value: unknown): value is NonNullable<PlacedImage['group']> {
  const pending = [{ value, depth: 1 }];
  let objects = 0;
  // Iterative validation bounds both deep/cyclic input and the total work across branches.
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== 'object' || depth > MAX_GROUP_DEPTH) return false;
    const group = value as NonNullable<PlacedImage['group']>;
    if (
      !Number.isFinite(group.width) ||
      !Number.isFinite(group.height) ||
      group.width <= 0 ||
      group.height <= 0 ||
      group.width > 100000 ||
      group.height > 100000 ||
      !Array.isArray(group.objects) ||
      group.objects.length < 2 ||
      (objects += group.objects.length) > MAX_GROUP_OBJECTS
    )
      return false;
    for (const image of group.objects) {
      if (
        !image ||
        !validNotebook({
          version: 1,
          name: 'group child',
          source: null,
          pages: [
            {
              id: 'group',
              sourceIndex: null,
              width: 1000,
              height: 1000,
              paper: 'plain',
              strokes: [],
              images: [{ ...image, group: undefined }],
            },
          ],
        })
      )
        return false;
      if (image.group !== undefined) pending.push({ value: image.group, depth: depth + 1 });
    }
  }
  return true;
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
