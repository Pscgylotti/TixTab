import { createContext } from 'react';
import type { Page, Point, Stroke } from './model';
export interface ScratchInkRouting {
  commit: (page: Page, stroke: Stroke, rect: DOMRect) => void;
  preview: (page: Page, stroke: Stroke | null, rect: DOMRect) => void;
  sampleErase: (page: Page, from: Point, to: Point, radius: number, rect: DOMRect) => void;
  previewErase: (owner: string) => number;
  finishErase: (owner: string, cancel: boolean) => void;
}
export const ScratchInkContext = createContext<ScratchInkRouting | null>(null);
