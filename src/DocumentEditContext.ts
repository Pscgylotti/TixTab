import { createContext } from 'react';
import type { Notebook } from './model';
import type { NativePdfEdit } from './pdfNativeTypes';
import type { PDFDocumentProxy } from './pdfTypes';
export const DocumentEditContext = createContext<{
  notebook: Notebook;
  pdf?: PDFDocumentProxy | null;
  mode: 'single' | 'continuous' | 'dual';
  onReviewCreated?: () => void;
  stageNative: (pageId: string, edit: NativePdfEdit) => void;
} | null>(null);
