import { createContext } from 'react';
import type { Page, Stroke } from './model';
export interface ScratchInkRouting {
  commit: (page: Page, stroke: Stroke, rect: DOMRect) => void;
  preview: (page: Page, stroke: Stroke | null, rect: DOMRect) => void;
}
export const ScratchInkContext = createContext<ScratchInkRouting | null>(null);
