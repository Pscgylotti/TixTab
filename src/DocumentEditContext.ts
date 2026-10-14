import { createContext } from 'react';
import type { Notebook } from './model';
import type { NativePdfEdit } from './pdfNativeTypes';
export const DocumentEditContext = createContext<{
  notebook: Notebook;
  mode: 'single' | 'continuous' | 'dual';
  stageNative: (pageId: string, edit: NativePdfEdit) => void;
} | null>(null);
