import { createContext } from 'react';
import type { Notebook } from './model';
import type { NativePdfEdit } from './pdfNativeTypes';
import type { PdfObjectEdit } from './pdfiumObjects';
import type { PDFDocumentProxy } from './pdfTypes';
export const DocumentEditContext = createContext<{
  notebook: Notebook;
  pdf?: PDFDocumentProxy | null;
  mode: 'single' | 'continuous' | 'dual';
  onReviewCreated?: () => void;
  stageNative: (pageId: string, edit: NativePdfEdit) => void;
  /** Applies page-object edits to the source PDF as one undoable step. */
  editPdfObjects: (pageId: string, edits: PdfObjectEdit[]) => Promise<void>;
} | null>(null);
