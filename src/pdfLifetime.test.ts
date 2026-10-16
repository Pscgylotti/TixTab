import { expect, it, vi } from 'vitest';
import { destroyPdf, retainPdf } from './pdf';
import type { PDFDocumentProxy } from './pdfTypes';
it('keeps a PDF usable for background owners and releases it when the last owner finishes', async () => {
  const destroy = vi.fn(async () => {});
  const pdf = { destroy } as unknown as PDFDocumentProxy;
  const releaseOne = retainPdf(pdf),
    releaseTwo = retainPdf(pdf);
  await destroyPdf(pdf);
  expect(destroy).not.toHaveBeenCalled();
  releaseOne();
  releaseOne();
  expect(destroy).not.toHaveBeenCalled();
  releaseTwo();
  releaseTwo();
  expect(destroy).toHaveBeenCalledTimes(1);
});
