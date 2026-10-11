import { t } from './i18n';
import type { Notebook, Page, Stroke } from './model';
import type { Locale } from './i18n';

export class SignedPdfExportError extends Error {
  constructor() {
    super(t('此 PDF 含数字签名。导出修改副本会使原签名失效。'));
    this.name = 'SignedPdfExportError';
  }
}
export type PdfExportProgress = {
  stage: 'preparing' | 'loading' | 'structure' | 'annotations' | 'saving';
  completed?: number;
  total?: number;
};
export type PackedStroke = Omit<Stroke, 'points'> &
  ({ points: Float64Array; path?: never } | { path: string; points?: never });
export type PackedNotebook = Omit<Notebook, 'pages' | 'scene'> & {
  pages: (Omit<Page, 'strokes'> & { strokes: PackedStroke[] })[];
};
export type PdfExportRequest = {
  notebook: PackedNotebook;
  locale: Locale;
  allowSignatureInvalidation: boolean;
};
export type PdfExportReply =
  | { type: 'progress'; progress: PdfExportProgress }
  | { type: 'complete'; bytes: ArrayBuffer }
  | { type: 'error'; signed: boolean; message: string };
export const cancelledPdfExport = () => new DOMException(t('已取消 PDF 导出'), 'AbortError');
