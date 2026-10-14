import { expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { paperAppearance } from './paperAppearance';
import { blankPage, newNotebook } from './model';
import { exportPdf } from './pdfExport';
it('keeps chosen colors and grid spacing proportional in preview and night conversion', () => {
  const page = { ...blankPage(400, 600), paper: 'fine-grid' as const, paperColor: '#fff7e6' };
  const day = paperAppearance(page),
    night = paperAppearance(page, true);
  expect(day.backgroundColor).toBe('rgb(255, 247, 230)');
  expect(day.backgroundSize).toBe('2.5% 1.6666666666666667%');
  expect(night.backgroundColor).not.toBe(day.backgroundColor);
  expect(day.backgroundImage).toContain('linear-gradient');
});
it('exports grids as a compact PDF tiling pattern instead of thousands of drawing paths', async () => {
  const notebook = {
    ...newNotebook(),
    pages: [{ ...blankPage(400, 600), paper: 'fine-grid' as const, paperColor: '#fff7e6' }],
  };
  const bytes = await exportPdf(notebook),
    doc = await PDFDocument.load(bytes);
  const patterns = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Pattern'), PDFDict);
  expect(patterns.has(PDFName.of('TixTabPaper'))).toBe(true);
  expect(bytes.length).toBeLessThan(6000);
});
