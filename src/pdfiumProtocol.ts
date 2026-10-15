export interface PdfiumRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type PdfiumRequest =
  | { type: 'open'; id: number; documentId: number; bytes: Uint8Array }
  | { type: 'release'; id: number; documentId: number }
  | {
      type: 'render';
      id: number;
      documentId: number;
      page: number;
      fullWidth: number;
      fullHeight: number;
      region: PdfiumRegion;
    }
  | { type: 'cancel'; id: number }
  | { type: 'resume'; id: number };
export type PdfiumResponse =
  | { type: 'opened'; id: number; documents: number }
  | { type: 'released'; id: number; heapBytes: number; documents: number }
  | { type: 'continue'; id: number }
  | { type: 'error'; id: number; error: string }
  | { type: 'rendered'; id: number; bitmap: ImageBitmap; heapBytes: number };
