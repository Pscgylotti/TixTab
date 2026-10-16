import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

/** Page-object editing on PDFium's own object model. Objects are changed in
 * place (matrix, style, removal, drawing order) and the page content stream is
 * regenerated from them, so untouched content keeps its exact operators,
 * fonts and position in the drawing order. Coordinates are PDF user space. */
export type PdfObjectKind = 'text' | 'path' | 'image' | 'shading' | 'form';
export interface PdfPageObject {
  /** Position in the page's drawing order; 0 is painted first. */
  index: number;
  kind: PdfObjectKind;
  /** Rotated bounds as four corners, x/y pairs. */
  quad: number[];
  /** Axis-aligned bounds: left, bottom, right, top. */
  bounds: number[];
  matrix: number[];
  text?: string;
  font?: string;
  fontSize?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** Changes when the object is no longer the one the caller inspected. */
  key: string;
}
export type PdfObjectOrder = 'front' | 'back' | 'forward' | 'backward';
export interface PdfObjectEdit {
  index: number;
  key: string;
  /** a b c d e f, applied after the object's own matrix (x' = a·x + c·y + e). */
  transform?: number[];
  delete?: boolean;
  order?: PdfObjectOrder;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}
const KINDS: Record<number, PdfObjectKind> = {
  1: 'text',
  2: 'path',
  3: 'image',
  4: 'shading',
  5: 'form',
};
export const MAX_PAGE_OBJECTS = 20000;

type Memory = WrappedPdfiumModule['pdfium'] & { HEAPU8: Uint8Array };
function scratch(api: WrappedPdfiumModule, bytes: number) {
  const m = api.pdfium as Memory,
    p = m.wasmExports.malloc(bytes);
  if (!p) throw new Error('pdf-object-memory');
  return {
    p,
    f: (i: number) => m.getValue(p + i * 4, 'float'),
    u: (i: number) => m.getValue(p + i * 4, 'i32') >>> 0,
    free: () => m.wasmExports.free(p),
  };
}
const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
function color(value: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error('invalid-color');
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function utf16(api: WrappedPdfiumModule, read: (buffer: number, bytes: number) => number) {
  const m = api.pdfium as Memory,
    bytes = read(0, 0);
  if (bytes <= 2) return '';
  const p = m.wasmExports.malloc(bytes);
  if (!p) throw new Error('pdf-object-memory');
  try {
    read(p, bytes);
    return new TextDecoder('utf-16le').decode(m.HEAPU8.slice(p, p + bytes - 2));
  } finally {
    m.wasmExports.free(p);
  }
}
function latin(api: WrappedPdfiumModule, read: (buffer: number, bytes: number) => number) {
  const m = api.pdfium as Memory,
    bytes = read(0, 0);
  if (bytes <= 1) return '';
  const p = m.wasmExports.malloc(bytes);
  if (!p) throw new Error('pdf-object-memory');
  try {
    read(p, bytes);
    return new TextDecoder().decode(m.HEAPU8.slice(p, p + bytes - 1));
  } finally {
    m.wasmExports.free(p);
  }
}
function objectKey(o: Omit<PdfPageObject, 'key' | 'index'>) {
  const r = (n: number) => Math.round(n * 10) / 10;
  return [o.kind, ...o.bounds.map(r), o.text ?? '', o.fontSize ? r(o.fontSize) : ''].join('|');
}

/** Top-level page objects in drawing order. A form XObject is one object. */
export function listPageObjects(api: WrappedPdfiumModule, page: number): PdfPageObject[] {
  const count = api.FPDFPage_CountObjects(page);
  if (count > MAX_PAGE_OBJECTS) throw new Error('element-limit');
  const s = scratch(api, 32);
  const textPage = api.FPDFText_LoadPage(page);
  try {
    const objects: PdfPageObject[] = [];
    for (let index = 0; index < count; index++) {
      const object = api.FPDFPage_GetObject(page, index),
        kind = KINDS[api.FPDFPageObj_GetType(object)];
      if (!kind) continue;
      if (!api.FPDFPageObj_GetBounds(object, s.p, s.p + 4, s.p + 8, s.p + 12)) continue;
      const bounds = [s.f(0), s.f(1), s.f(2), s.f(3)];
      if (!bounds.every(Number.isFinite)) continue;
      const quad = api.FPDFPageObj_GetRotatedBounds(object, s.p)
        ? Array.from({ length: 8 }, (_, i) => s.f(i))
        : [bounds[0], bounds[1], bounds[2], bounds[1], bounds[2], bounds[3], bounds[0], bounds[3]];
      const matrix = api.FPDFPageObj_GetMatrix(object, s.p)
        ? Array.from({ length: 6 }, (_, i) => s.f(i))
        : [1, 0, 0, 1, 0, 0];
      const item: Omit<PdfPageObject, 'key'> = { index, kind, quad, bounds, matrix };
      if (kind === 'text') {
        if (textPage)
          item.text = utf16(api, (buffer, bytes) =>
            api.FPDFTextObj_GetText(object, textPage, buffer, bytes),
          );
        if (api.FPDFTextObj_GetFontSize(object, s.p)) item.fontSize = s.f(0);
        const font = api.FPDFTextObj_GetFont(object);
        if (font)
          item.font = latin(api, (buffer, bytes) =>
            api.FPDFFont_GetBaseFontName(font, buffer, bytes),
          );
      }
      if (kind === 'text' || kind === 'path') {
        if (api.FPDFPageObj_GetFillColor(object, s.p, s.p + 4, s.p + 8, s.p + 12))
          item.fill = hex(s.u(0), s.u(1), s.u(2));
        if (api.FPDFPageObj_GetStrokeColor(object, s.p, s.p + 4, s.p + 8, s.p + 12))
          item.stroke = hex(s.u(0), s.u(1), s.u(2));
        if (kind === 'path' && api.FPDFPageObj_GetStrokeWidth(object, s.p))
          item.strokeWidth = s.f(0);
      }
      objects.push({ ...item, key: objectKey(item) });
    }
    return objects;
  } finally {
    if (textPage) api.FPDFText_ClosePage(textPage);
    s.free();
  }
}

/** New stacking order for the selected handles, keeping their relative order. */
export function reorder<T>(items: T[], selected: Set<T>, order: PdfObjectOrder): T[] {
  const result = [...items];
  if (order === 'front' || order === 'back') {
    const chosen = result.filter((item) => selected.has(item)),
      rest = result.filter((item) => !selected.has(item));
    return order === 'front' ? [...rest, ...chosen] : [...chosen, ...rest];
  }
  // One step past the nearest unselected neighbour, like Foxit's Bring Forward.
  const forward = order === 'forward';
  const indices = result.map((_, i) => i);
  for (const i of forward ? indices.reverse() : indices) {
    if (!selected.has(result[i])) continue;
    const j = forward ? i + 1 : i - 1;
    if (j < 0 || j >= result.length || selected.has(result[j])) continue;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Applies all edits to one page or none of them, then regenerates its content.
 * Every edit names the object by index and the key the caller saw. */
export function editPageObjects(api: WrappedPdfiumModule, page: number, edits: PdfObjectEdit[]) {
  if (!edits.length) return;
  if (edits.length > MAX_PAGE_OBJECTS) throw new Error('element-limit');
  const current = listPageObjects(api, page),
    byIndex = new Map(current.map((o) => [o.index, o]));
  for (const edit of edits) {
    if (byIndex.get(edit.index)?.key !== edit.key) throw new Error('element-stale');
    if (edit.transform && (edit.transform.length !== 6 || !edit.transform.every(Number.isFinite)))
      throw new Error('invalid-transform');
    if (edit.transform) {
      const [a, b, c, d] = edit.transform;
      if (Math.abs(a * d - b * c) < 1e-6) throw new Error('invalid-transform');
    }
    if (edit.strokeWidth !== undefined && !(edit.strokeWidth >= 0 && edit.strokeWidth <= 1000))
      throw new Error('invalid-stroke');
    for (const value of [edit.fill, edit.stroke]) if (value !== undefined) color(value);
  }
  const count = api.FPDFPage_CountObjects(page),
    handles = Array.from({ length: count }, (_, i) => api.FPDFPage_GetObject(page, i));
  for (const edit of edits) {
    const object = handles[edit.index];
    if (edit.transform) {
      const [a, b, c, d, e, f] = edit.transform;
      api.FPDFPageObj_Transform(object, a, b, c, d, e, f);
      // The visible part of a clipped object moves with it.
      if (api.FPDFPageObj_GetClipPath(object))
        api.FPDFPageObj_TransformClipPath(object, a, b, c, d, e, f);
    }
    if (edit.fill)
      api.FPDFPageObj_SetFillColor(object, ...(color(edit.fill) as [number, number, number]), 255);
    if (edit.stroke)
      api.FPDFPageObj_SetStrokeColor(
        object,
        ...(color(edit.stroke) as [number, number, number]),
        255,
      );
    if (edit.strokeWidth !== undefined) api.FPDFPageObj_SetStrokeWidth(object, edit.strokeWidth);
  }
  const removed = new Set(edits.filter((e) => e.delete).map((e) => handles[e.index]));
  let order = handles.filter((h) => !removed.has(h));
  for (const kind of ['back', 'backward', 'forward', 'front'] as const) {
    const chosen = new Set(edits.filter((e) => e.order === kind).map((e) => handles[e.index]));
    if (chosen.size) order = reorder(order, chosen, kind);
  }
  for (const handle of removed) {
    if (!api.FPDFPage_RemoveObject(page, handle)) throw new Error('pdf-edit');
    api.FPDFPageObj_Destroy(handle);
  }
  // Move only objects whose position changed; RemoveObject keeps them alive.
  for (let i = 0; i < order.length; i++) {
    if (api.FPDFPage_GetObject(page, i) === order[i]) continue;
    if (!api.FPDFPage_RemoveObject(page, order[i])) throw new Error('pdf-edit');
    if (!api.FPDFPage_InsertObjectAtIndex(page, order[i], i)) throw new Error('pdf-edit');
  }
  if (!api.FPDFPage_GenerateContent(page)) throw new Error('pdf-edit');
}

/** RGBA pixels of only the given objects ('only', transparent elsewhere) or of
 * the page without them ('except', on white). `matrix` maps displayed page
 * coordinates (top-left origin, page rotation and crop applied) to device pixels. Objects are hidden only for this render and always restored. */
export function renderObjects(
  api: WrappedPdfiumModule,
  page: number,
  indices: number[],
  matrix: number[],
  width: number,
  height: number,
  mode: 'only' | 'except',
): Uint8ClampedArray<ArrayBuffer> {
  if (!(width > 0 && height > 0) || width * height > 16_000_000)
    throw new Error('pdf-object-memory');
  const m = api.pdfium as Memory,
    chosen = new Set(indices),
    count = api.FPDFPage_CountObjects(page),
    hidden: number[] = [];
  const bitmap = api.FPDFBitmap_Create(width, height, 1),
    p = m.wasmExports.malloc(40);
  if (!bitmap || !p) {
    if (bitmap) api.FPDFBitmap_Destroy(bitmap);
    if (p) m.wasmExports.free(p);
    throw new Error('pdf-object-memory');
  }
  try {
    for (let i = 0; i < count; i++)
      if (chosen.has(i) !== (mode === 'only')) {
        const object = api.FPDFPage_GetObject(page, i);
        if (api.FPDFPageObj_SetIsActive(object, false)) hidden.push(object);
      }
    api.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, mode === 'only' ? 0 : 0xffffffff);
    matrix.forEach((v, i) => m.setValue(p + i * 4, v, 'float'));
    [0, 0, width, height].forEach((v, i) => m.setValue(p + 24 + i * 4, v, 'float'));
    // 0x10 FPDF_REVERSE_BYTE_ORDER: RGBA, ready for ImageData.
    api.FPDF_RenderPageBitmapWithMatrix(bitmap, page, p, p + 24, 0x10);
    const buffer = api.FPDFBitmap_GetBuffer(bitmap),
      stride = api.FPDFBitmap_GetStride(bitmap),
      out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      out.set(
        m.HEAPU8.subarray(buffer + y * stride, buffer + y * stride + width * 4),
        y * width * 4,
      );
    return out;
  } finally {
    for (const object of hidden) api.FPDFPageObj_SetIsActive(object, true);
    api.FPDFBitmap_Destroy(bitmap);
    m.wasmExports.free(p);
  }
}
/** Same refusals as the PyMuPDF editor: never alter signed or locked documents. */
export function checkEditable(api: WrappedPdfiumModule, document: number) {
  if (api.FPDF_GetSignatureCount(document) > 0) throw new Error('signed-edit');
  // Unencrypted documents report every permission bit; bit 4 allows content changes.
  if ((api.FPDF_GetDocPermissions(document) & 8) === 0) throw new Error('pdf-permissions');
}
export function saveDocument(api: WrappedPdfiumModule, document: number): Uint8Array {
  const m = api.pdfium as Memory,
    writer = api.PDFiumExt_OpenFileWriter();
  if (!writer) throw new Error('pdf-object-memory');
  try {
    if (!api.PDFiumExt_SaveAsCopy(document, writer)) throw new Error('pdf-edit');
    const size = api.PDFiumExt_GetFileWriterSize(writer);
    if (!(size > 0) || size > 512 * 1024 * 1024) throw new Error('pdf-size');
    const p = m.wasmExports.malloc(size);
    if (!p) throw new Error('pdf-object-memory');
    try {
      api.PDFiumExt_GetFileWriterData(writer, p, size);
      return m.HEAPU8.slice(p, p + size);
    } finally {
      m.wasmExports.free(p);
    }
  } finally {
    api.PDFiumExt_CloseFileWriter(writer);
  }
}
