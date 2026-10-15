import type { Page } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import { capturePage } from './capturePage';
// Only the most recently saved first page is retained. No document or bitmap cache.
let cached:
  { page: WeakRef<Page>; pdf: WeakRef<PDFDocumentProxy> | null; value: string } | undefined;
export async function workspacePreview(page: Page | undefined, pdf?: PDFDocumentProxy | null) {
  if (!page || (page.sourceIndex !== null && !pdf)) return undefined;
  const source = page.sourceIndex === null ? null : pdf!;
  if (cached?.page.deref() === page && (cached.pdf?.deref() ?? null) === source)
    return cached.value;
  try {
    const value = await capturePage(
      page,
      source,
      { x: 0, y: 0, width: page.width, height: page.height },
      { scale: Math.min(1, 192 / Math.max(page.width, page.height)) },
    );
    cached = { page: new WeakRef(page), pdf: source ? new WeakRef(source) : null, value };
    return value;
  } catch {
    // A failed preview must never prevent document contents from being saved.
    return undefined;
  }
}
