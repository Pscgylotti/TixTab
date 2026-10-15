import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type { PdfiumRequest, PdfiumResponse } from './pdfiumProtocol';
import { sourcePageGeometry } from './pdfiumSourceGeometry';
import { nativeDestination, nativeOutline, nativeLinks } from './pdfiumNavigation';
import { nativeText } from './pdfiumText';
import { nativeImages, nativeOriginalImage } from './pdfiumImages';

const scope = self as unknown as {
  postMessage: (data: PdfiumResponse, transfer: Transferable[]) => void;
  onmessage: (event: MessageEvent<PdfiumRequest>) => void;
};
let library: Promise<WrappedPdfiumModule> | undefined;
const documents = new Map<number, { handle: number; pointer: number; imageSupport: boolean[] }>();
let queue = Promise.resolve();
const jobs = new Set<number>(),
  cancelled = new Set<number>();
const resumes = new Map<number, () => void>();
const send = (data: PdfiumResponse, transfer: Transferable[] = []) =>
  scope.postMessage(data, transfer);
const check = (id: number) => {
  if (cancelled.has(id)) throw new Error('cancelled');
};
function engine() {
  return (library ??= (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error('PDFium WASM unavailable');
    const module = await init({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
    module.PDFiumExt_Init();
    return module;
  })());
}

async function run(message: Exclude<PdfiumRequest, { type: 'resume' | 'cancel' }>) {
  check(message.id);
  const pdfium = await engine();
  check(message.id);
  const memory = pdfium.pdfium as typeof pdfium.pdfium & { HEAPU8: Uint8Array };
  if (message.type === 'release') {
    const document = documents.get(message.documentId);
    if (document) {
      pdfium.FPDF_CloseDocument(document.handle);
      memory.wasmExports.free(document.pointer);
      documents.delete(message.documentId);
    }
    send({
      type: 'released',
      id: message.id,
      heapBytes: memory.HEAPU8.byteLength,
      documents: documents.size,
    });
    return;
  }
  if (message.type === 'open') {
    if (documents.has(message.documentId)) throw new Error('PDFium document already open');
    const filePointer = memory.wasmExports.malloc(message.bytes.length);
    if (!filePointer) throw new Error('PDFium allocation failed');
    memory.HEAPU8.set(message.bytes, filePointer);
    const documentHandle = pdfium.FPDF_LoadMemDocument(filePointer, message.bytes.length, '');
    if (!documentHandle) {
      memory.wasmExports.free(filePointer);
      throw new Error(`PDFium document error ${pdfium.FPDF_GetLastError()}`);
    }
    try {
      const pageCount = pdfium.FPDF_GetPageCount(documentHandle);
      const hints = message.imageSupport;
      const reuse =
        !!hints && hints.length === pageCount && hints.every((v) => typeof v === 'boolean');
      // Isolated image decoders reuse preflight from the immutable reader
      // document; do not build another pdf-lib graph or scan all content again.
      const { pages, imageSupport } = reuse
        ? { pages: [], imageSupport: hints! }
        : await sourcePageGeometry(message.bytes, () => check(message.id));
      if (!reuse && pages.length !== pageCount) throw new Error('PDF page tree mismatch');
      check(message.id);
      documents.set(message.documentId, {
        handle: documentHandle,
        pointer: filePointer,
        imageSupport,
      });
      send({ type: 'opened', id: message.id, documents: documents.size, pages, imageSupport });
    } catch (error) {
      pdfium.FPDF_CloseDocument(documentHandle);
      memory.wasmExports.free(filePointer);
      throw error;
    }
    return;
  }
  const documentHandle = documents.get(message.documentId)?.handle;
  if (!documentHandle) throw new Error('PDFium document not open');
  if (message.type === 'images' || message.type === 'original-image') {
    if (!documents.get(message.documentId)!.imageSupport[message.page])
      throw new Error('PDFium image compatibility required');
    const page = pdfium.FPDF_LoadPage(documentHandle, message.page);
    if (!page) throw new Error('PDFium page unavailable');
    try {
      const images = await nativeImages(pdfium, page, () => check(message.id));
      if (message.type === 'images')
        send({ type: 'images', id: message.id, polygons: images.map((image) => image.polygon) });
      else {
        if (
          !Number.isSafeInteger(message.image) ||
          !(message.maxPixels > 0 && message.maxPixels <= 64_000_000)
        )
          throw new Error('PDFium image size limit');
        const image = images[message.image],
          bitmap = image
            ? nativeOriginalImage(pdfium, documentHandle, page, image, message.maxPixels)
            : null;
        try {
          check(message.id);
          send(
            { type: 'original-image', id: message.id, bitmap, heapBytes: memory.HEAPU8.byteLength },
            bitmap ? [bitmap] : [],
          );
        } catch (error) {
          bitmap?.close();
          throw error;
        }
      }
    } finally {
      pdfium.FPDF_ClosePage(page);
    }
    return;
  }
  if (message.type === 'outline') {
    send({ type: 'outline', id: message.id, items: nativeOutline(pdfium, documentHandle) });
    return;
  }
  if (message.type === 'destination') {
    send({
      type: 'destination',
      id: message.id,
      dest: nativeDestination(
        pdfium,
        documentHandle,
        pdfium.FPDF_GetNamedDestByName(documentHandle, message.name),
      ),
    });
    return;
  }
  if (message.type === 'annotations' || message.type === 'text') {
    const page = pdfium.FPDF_LoadPage(documentHandle, message.page);
    if (!page) throw new Error('PDFium page unavailable');
    try {
      if (message.type === 'text')
        send({
          type: 'text',
          id: message.id,
          content: await nativeText(pdfium, page, () => check(message.id)),
        });
      else
        send({
          type: 'annotations',
          id: message.id,
          items: nativeLinks(pdfium, documentHandle, page),
        });
    } finally {
      pdfium.FPDF_ClosePage(page);
    }
    return;
  }
  const { region, fullWidth, fullHeight } = message;
  if (
    ![fullWidth, fullHeight, region.x, region.y, region.width, region.height].every(
      Number.isSafeInteger,
    ) ||
    fullWidth <= 0 ||
    fullHeight <= 0 ||
    fullWidth > 10_000_000 ||
    fullHeight > 10_000_000 ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.width * region.height > 32_000_000 ||
    Math.max(region.width, region.height) > 32767
  )
    throw new Error('PDFium raster size limit');
  const page = pdfium.FPDF_LoadPage(documentHandle, message.page);
  if (!page) throw new Error('PDFium page unavailable');
  let bitmap = 0,
    pause = 0,
    callback = 0,
    rendering = false;
  let output: OffscreenCanvas | undefined;
  try {
    bitmap = pdfium.FPDFBitmap_Create(region.width, region.height, 1);
    if (!bitmap) throw new Error('PDFium bitmap allocation failed');
    pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, region.width, region.height, 0xffffffff);
    let deadline = performance.now() + 8;
    callback = memory.addFunction(() => (performance.now() >= deadline ? 1 : 0), 'ii');
    // wasm32 IFSDK_PAUSE: version, callback pointer, user pointer.
    pause = memory.wasmExports.malloc(12);
    if (!pause) throw new Error('PDFium pause allocation failed');
    memory.setValue(pause, 1, 'i32');
    memory.setValue(pause + 4, callback, 'i32');
    memory.setValue(pause + 8, 0, 'i32');
    rendering = true;
    // Intrinsic CropBox and page rotation are handled by PDFium. The viewport
    // dimensions come from the shared page model. 0x10 = RGBA, 1 = annotations.
    let status = pdfium.FPDF_RenderPageBitmap_Start(
      bitmap,
      page,
      -region.x,
      -region.y,
      fullWidth,
      fullHeight,
      0,
      0x11,
      pause,
    );
    while (status === 1) {
      await new Promise<void>((resolve) => {
        resumes.set(message.id, resolve);
        send({ type: 'continue', id: message.id });
      });
      resumes.delete(message.id);
      check(message.id);
      deadline = performance.now() + 8;
      status = pdfium.FPDF_RenderPage_Continue(page, pause);
    }
    check(message.id);
    if (status !== 2) throw new Error('PDFium progressive render failed');
    const pointer = pdfium.FPDFBitmap_GetBuffer(bitmap);
    const stride = pdfium.FPDFBitmap_GetStride(bitmap);
    if (!pointer || stride < region.width * 4) throw new Error('PDFium bitmap buffer unavailable');
    const rgba = new Uint8ClampedArray(region.width * region.height * 4);
    for (let y = 0; y < region.height; y++)
      rgba.set(
        memory.HEAPU8.subarray(pointer + y * stride, pointer + y * stride + region.width * 4),
        y * region.width * 4,
      );
    output = new OffscreenCanvas(region.width, region.height);
    output.getContext('2d')!.putImageData(new ImageData(rgba, region.width, region.height), 0, 0);
    const image = output.transferToImageBitmap();
    send({ type: 'rendered', id: message.id, bitmap: image, heapBytes: memory.HEAPU8.byteLength }, [
      image,
    ]);
  } finally {
    if (rendering) pdfium.FPDF_RenderPage_Close(page);
    if (pause) memory.wasmExports.free(pause);
    if (callback) memory.removeFunction(callback);
    if (bitmap) pdfium.FPDFBitmap_Destroy(bitmap);
    pdfium.FPDF_ClosePage(page);
    if (output) output.width = output.height = 1;
  }
}
scope.onmessage = ({ data: message }: MessageEvent<PdfiumRequest>) => {
  if (message.type === 'resume' || message.type === 'cancel') {
    if (message.type === 'cancel' && jobs.has(message.id)) cancelled.add(message.id);
    resumes.get(message.id)?.();
    return;
  }
  jobs.add(message.id);
  queue = queue
    .then(() => run(message))
    .catch((error) => {
      send({
        type: 'error',
        id: message.id,
        error: error instanceof Error ? error.message : 'PDFium error',
      });
    })
    .finally(() => {
      jobs.delete(message.id);
      cancelled.delete(message.id);
      resumes.delete(message.id);
    });
};
