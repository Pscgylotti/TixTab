import type { PdfObjectEdit, PdfPageObject } from './pdfiumObjects';
import type { PdfObjectsRequest } from './pdfObjects.worker';

/** Each source revision gets an id; the worker keeps the last one open, so the
 * bytes cross the thread boundary only when the revision changes. */
const ids = new WeakMap<Uint8Array, number>();
let nextId = 1,
  sequence = 0,
  loaded = 0,
  worker: Worker | undefined,
  idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<
  number,
  { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void }
>();
const revision = (bytes: Uint8Array) => {
  let id = ids.get(bytes);
  if (!id) ids.set(bytes, (id = nextId++));
  return id;
};
function stop() {
  worker?.terminate();
  worker = undefined;
  loaded = 0;
  for (const p of pending.values()) p.reject(new Error('pdf-edit'));
  pending.clear();
}
function connect() {
  clearTimeout(idle);
  if (!worker) {
    worker = new Worker(new URL('./pdfObjects.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = stop;
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.ok) p.resolve(data);
      else p.reject(new Error(data.error));
      // Release the PDFium heap and the open document after a quiet minute.
      if (!pending.size) idle = setTimeout(stop, 60_000);
    };
  }
  return worker;
}
type Body =
  | { type: 'list'; page: number }
  | {
      type: 'lift';
      page: number;
      indices: number[];
      box: number[];
      scale: number;
      night?: { only: number[][]; except: number[][] };
    }
  | { type: 'edit'; page: number; edits: PdfObjectEdit[]; result: number };
async function request(
  source: Uint8Array,
  body: Body,
  retry = true,
): Promise<Record<string, unknown>> {
  const document = revision(source),
    id = ++sequence,
    message = {
      ...body,
      id,
      document,
      source: loaded === document ? undefined : source,
    } as PdfObjectsRequest;
  loaded = body.type === 'edit' ? body.result : document;
  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      connect().postMessage(message);
    });
  } catch (error) {
    loaded = 0;
    if (retry && error instanceof Error && error.message === 'need-source')
      return request(source, body, false);
    throw error;
  }
}
export async function listPdfObjects(source: Uint8Array, page: number) {
  const data = await request(source, { type: 'list', page });
  return data.objects as PdfPageObject[];
}
/** Returns the edited PDF; the input bytes are never modified. */
export async function editPdfObjects(source: Uint8Array, page: number, edits: PdfObjectEdit[]) {
  const result = nextId++,
    data = await request(source, { type: 'edit', page, edits, result });
  const bytes = data.source as Uint8Array;
  ids.set(bytes, result);
  return bytes;
}

/** The selected objects alone and the page without them, for a live drag
 * preview of `box` (page coordinates) at `scale` device pixels per unit. */
export async function liftPdfObjects(
  source: Uint8Array,
  page: number,
  indices: number[],
  box: number[],
  scale: number,
  night?: { only: number[][]; except: number[][] },
) {
  const data = await request(source, { type: 'lift', page, indices, box, scale, night });
  return { only: data.only as ImageBitmap, except: data.except as ImageBitmap };
}
