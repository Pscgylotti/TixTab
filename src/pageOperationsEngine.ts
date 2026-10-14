import { PDFDocument, PDFName, PDFDict, degrees } from 'pdf-lib';
import { exportPageGeometry } from './pdfExport';
import type { Notebook } from './model';
import { transformPage, type PageOperation } from './pageOperations';
/** This runs inside a short-lived worker; only immutable source bytes are copied. */
export async function operatePages(
  notebook: Notebook,
  indices: number[],
  operation: PageOperation,
): Promise<Notebook> {
  if (!indices.length || indices.some((i) => !Number.isInteger(i) || !notebook.pages[i]))
    throw Error('page-range');
  if (operation.action === 'rotate' && ![90, 180, 270].includes(operation.angle))
    throw Error('page-angle');
  if (operation.action === 'crop') {
    const c = operation.margins;
    if (
      Object.values(c).some((n) => !Number.isFinite(n) || n < 0 || n >= 100) ||
      c.left + c.right >= 95 ||
      c.top + c.bottom >= 95
    )
      throw Error('crop-range');
  }
  const selected = new Set(indices),
    pages = notebook.pages.map((p, i) => (selected.has(i) ? transformPage(p, operation) : p));
  let source = notebook.source;
  if (source && indices.some((i) => notebook.pages[i].sourceIndex !== null)) {
    const doc = await PDFDocument.load(source, { updateMetadata: false });
    const counts = new Map<number, number>();
    for (const p of notebook.pages)
      if (p.sourceIndex !== null) counts.set(p.sourceIndex, (counts.get(p.sourceIndex) || 0) + 1);
    // Editing a signed source would invalidate its signature. Require a deliberately unsigned copy.
    for (const [, obj] of doc.context.enumerateIndirectObjects())
      if (obj instanceof PDFDict && obj.has(PDFName.of('ByteRange'))) throw Error('signed-edit');
    for (const i of indices) {
      const original = notebook.pages[i];
      if (original.sourceIndex === null) continue;
      const p = doc.getPage(original.sourceIndex);
      if ((counts.get(original.sourceIndex) || 0) > 1) throw Error('shared-page');
      if (operation.action === 'rotate')
        p.setRotation(degrees((p.getRotation().angle + operation.angle) % 360));
      else {
        const g = exportPageGeometry(p),
          c = operation.margins,
          m = g.matrix;
        const corners = [
          [(original.width * c.left) / 100, (original.height * c.bottom) / 100],
          [original.width * (1 - c.right / 100), original.height * (1 - c.top / 100)],
        ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const x = Math.min(corners[0][0], corners[1][0]),
          y = Math.min(corners[0][1], corners[1][1]);
        p.setCropBox(
          x,
          y,
          Math.abs(corners[0][0] - corners[1][0]),
          Math.abs(corners[0][1] - corners[1][1]),
        );
      }
      // PDF-native OCR polygons use the original PDF coordinate system and need no transform.
      const g = exportPageGeometry(p);
      pages[i] = { ...pages[i], width: g.width, height: g.height };
    }
    source = await doc.save({ updateFieldAppearances: false });
  }
  return { ...notebook, source, pages };
}
