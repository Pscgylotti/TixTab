import type { PdfViewport, ViewportOptions } from './pdfViewport';
/** Application-owned document contracts. Consumers retain plain data only. */
export interface TextItem {
  str: string;
  dir: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
  hasEOL: boolean;
}
export interface TextStyle {
  fontFamily: string;
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}
export interface TextContent {
  items: (TextItem | { type: string; id?: string })[];
  styles: Record<string, TextStyle>;
  lang?: string | null;
}
export interface RenderTask {
  promise: Promise<void>;
  cancel: (extraDelay?: number) => void;
  onContinue?: (resume: () => void) => void;
}
export interface RenderOptions {
  canvas?: HTMLCanvasElement | null;
  canvasContext?: CanvasRenderingContext2D;
  viewport: PdfViewport;
  transform?: number[];
  background?: string;
  widgets?: boolean;
}
export interface PdfLink {
  subtype: string;
  rect: number[];
  quadPoints?: number[];
  dest?: unknown[] | string;
  url?: string;
  unsafeUrl?: string;
}
export interface PdfOutline {
  title: string;
  dest?: unknown[] | string;
  url?: string;
  items: PdfOutline[];
}
export interface PDFPageProxy {
  pageNumber: number;
  view: number[];
  rotate: number;
  userUnit: number;
  getViewport: (options: ViewportOptions) => PdfViewport;
  getTextContent: () => Promise<TextContent>;
  getAnnotations: (options?: { intent?: string }) => Promise<PdfLink[]>;
  render: (options: RenderOptions) => RenderTask;
  cleanup: () => boolean;
}
export interface PDFDocumentProxy {
  numPages: number;
  getPage: (number: number) => Promise<PDFPageProxy>;
  getData: () => Promise<Uint8Array>;
  getImages: (index: number) => Promise<number[][]>;
  getOutline: () => Promise<PdfOutline[] | null>;
  getDestination: (name: string) => Promise<unknown[] | null>;
  getPageIndex: (ref: { num: number; gen: number }) => Promise<number>;
  cleanup: () => Promise<void>;
  destroy: () => Promise<void>;
}
