import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import {
  checkEditable,
  editPageObjects,
  listPageObjects,
  renderObjects,
  saveDocument,
  type PdfObjectEdit,
} from './pdfiumObjects';
import { transformNightPixels } from './pdfNightColors';

export type PdfObjectsRequest =
  | { id: number; type: 'list'; document: number; source?: Uint8Array; page: number }
  | {
      id: number;
      type: 'edit';
      document: number;
      source?: Uint8Array;
      page: number;
      edits: PdfObjectEdit[];
      /** Identity of the edited document for later requests. */
      result: number;
    }
  | {
      id: number;
      type: 'lift';
      document: number;
      source?: Uint8Array;
      page: number;
      indices: number[];
      /** left, top, right, bottom in displayed page coordinates. */
      box: number[];
      scale: number;
      /** Night colours, with picture areas (page coordinates) dimmed instead of inverted. */
      night?: { only: number[][]; except: number[][] };
    };
/** Bitmaps for a drag preview, converted like the page itself in night mode. */
function liftBitmap(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  matrix: number[],
  pictures?: number[][],
) {
  if (pictures) {
    let mask: Uint8ClampedArray | undefined;
    if (pictures.length) {
      const canvas = new OffscreenCanvas(width, height),
        ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
      ctx.fillStyle = 'white';
      for (const p of pictures) {
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
        ctx.closePath();
        ctx.fill();
      }
      mask = ctx.getImageData(0, 0, width, height).data;
    }
    transformNightPixels(pixels, mask);
  }
  return createImageBitmap(new ImageData(pixels, width, height));
}
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PdfObjectsRequest>) => void) | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};
let library: Promise<WrappedPdfiumModule> | undefined;
/** One open document: repeated inspections and successive edits of the same
 * source do not copy it into the PDFium heap again. */
let open: { id: number; handle: number; pointer: number } | undefined;
function engine() {
  return (library ??= (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error('pdf-edit');
    const module = await init({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
    module.PDFiumExt_Init();
    return module;
  })());
}
function close(api: WrappedPdfiumModule) {
  if (!open) return;
  api.FPDF_CloseDocument(open.handle);
  api.pdfium.wasmExports.free(open.pointer);
  open = undefined;
}
function load(api: WrappedPdfiumModule, id: number, source?: Uint8Array) {
  if (open?.id === id) return open.handle;
  if (!source) throw new Error('need-source');
  close(api);
  const memory = api.pdfium as typeof api.pdfium & { HEAPU8: Uint8Array },
    pointer = memory.wasmExports.malloc(source.length);
  if (!pointer) throw new Error('pdf-object-memory');
  memory.HEAPU8.set(source, pointer);
  const handle = api.FPDF_LoadMemDocument(pointer, source.length, '');
  if (!handle) {
    memory.wasmExports.free(pointer);
    throw new Error(api.FPDF_GetLastError() === 4 ? 'pdf-permissions' : 'pdf-edit');
  }
  open = { id, handle, pointer };
  return handle;
}
let queue = Promise.resolve();
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const api = await engine(),
        document = load(api, data.document, data.source);
      if (data.page < 0 || data.page >= api.FPDF_GetPageCount(document))
        throw new Error('page-range');
      const page = api.FPDF_LoadPage(document, data.page);
      if (!page) throw new Error('pdf-edit');
      try {
        if (data.type === 'list') {
          scope.postMessage({ id: data.id, ok: true, objects: listPageObjects(api, page) });
          return;
        }
        if (data.type === 'lift') {
          const [x0, y0, x1, y1] = data.box,
            width = Math.max(1, Math.ceil((x1 - x0) * data.scale)),
            height = Math.max(1, Math.ceil((y1 - y0) * data.scale)),
            matrix = [data.scale, 0, 0, data.scale, -x0 * data.scale, -y0 * data.scale];
          const only = await liftBitmap(
              renderObjects(api, page, data.indices, matrix, width, height, 'only'),
              width,
              height,
              matrix,
              data.night?.only,
            ),
            except = await liftBitmap(
              renderObjects(api, page, data.indices, matrix, width, height, 'except'),
              width,
              height,
              matrix,
              data.night?.except,
            );
          scope.postMessage({ id: data.id, ok: true, only, except }, [only, except]);
          return;
        }
        checkEditable(api, document);
        try {
          editPageObjects(api, page, data.edits);
        } catch (error) {
          // A failed transaction may have touched the loaded copy; reload next time.
          api.FPDF_ClosePage(page);
          close(api);
          throw error;
        }
        const bytes = saveDocument(api, document);
        open!.id = data.result;
        scope.postMessage({ id: data.id, ok: true, source: bytes }, [bytes.buffer]);
      } finally {
        if (open?.handle === document) api.FPDF_ClosePage(page);
      }
    } catch (error) {
      scope.postMessage({
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : 'pdf-edit',
      });
    }
  });
};
