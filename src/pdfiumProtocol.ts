import type { TextContent } from './pdfTextContent';
export interface PdfiumRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfiumPageInfo {
  view: number[];
  rotation: number;
  userUnit: number;
  objectNumber: number;
}
export interface PdfiumOutline {
  title: string;
  dest?: unknown[];
  url?: string;
  items: PdfiumOutline[];
}
export type PdfiumRequest =
  | { type: 'open'; id: number; documentId: number; bytes: Uint8Array }
  | { type: 'release'; id: number; documentId: number }
  | { type: 'outline'; id: number; documentId: number }
  | { type: 'destination'; id: number; documentId: number; name: string }
  | { type: 'annotations'; id: number; documentId: number; page: number }
  | { type: 'text'; id: number; documentId: number; page: number }
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
  | { type: 'opened'; id: number; documents: number; pages: PdfiumPageInfo[] }
  | { type: 'outline'; id: number; items: PdfiumOutline[] }
  | { type: 'destination'; id: number; dest: unknown[] | null }
  | { type: 'text'; id: number; content: TextContent }
  | {
      type: 'annotations';
      id: number;
      items: {
        subtype: 'Link';
        rect: number[];
        quadPoints?: number[];
        dest?: unknown[];
        url?: string;
      }[];
    }
  | { type: 'released'; id: number; heapBytes: number; documents: number }
  | { type: 'continue'; id: number }
  | { type: 'error'; id: number; error: string }
  | { type: 'rendered'; id: number; bitmap: ImageBitmap; heapBytes: number };
