import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
/** Static AcroForm appearances are a separate PDFium drawing pass. No focus,
 * field input, timers, JavaScript platform or document/page actions are wired.
 * The wasm32 version-1 FPDF_FORMFILLINFO is zero-initialized and owned until
 * ExitFormFillEnvironment. public/fpdf_formfill.h defines this lifecycle. */
export function openPdfiumForms(api: WrappedPdfiumModule, document: number) {
  if (api.FPDF_GetFormType(document) !== 1) return undefined;
  const memory = api.pdfium as typeof api.pdfium & { HEAPU8: Uint8Array };
  const pointer = memory.wasmExports.malloc(256);
  if (!pointer) throw new Error('PDF form allocation failed');
  memory.HEAPU8.fill(0, pointer, pointer + 256);
  memory.setValue(pointer, 1, 'i32');
  const handle = api.FPDFDOC_InitFormFillEnvironment(document, pointer);
  if (!handle) {
    memory.wasmExports.free(pointer);
    throw new Error('PDF form rendering unavailable');
  }
  return {
    handle,
    close: () => {
      api.FPDFDOC_ExitFormFillEnvironment(handle);
      memory.wasmExports.free(pointer);
    },
  };
}
