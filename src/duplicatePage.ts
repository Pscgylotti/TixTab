import { uid, type Notebook, type Page, type PlacedImage } from './model';
export function clonePage(page: Page, sourceIndex = page.sourceIndex): Page {
  const copy = structuredClone(page);
  const resetImageIds = (image: PlacedImage): PlacedImage => {
    image.id = uid();
    image.group?.objects.forEach(resetImageIds);
    return image;
  };
  return {
    ...copy,
    id: uid(),
    sourceIndex,
    strokes: copy.strokes.map((s) => ({ ...s, id: uid() })),
    images: copy.images.map(resetImageIds),
    reviews: copy.reviews?.map((n) => ({ ...n, id: uid() })),
  };
}
/** Give a duplicate its own source page, so export never aliases one PDF page twice. */
export async function duplicateNotebookPage(notebook: Notebook, index: number): Promise<Notebook> {
  if (notebook.pages.some((p) => p.pdfEdits?.length))
    throw new Error('请先应用或放弃暂存的 PDF 元素编辑，再复制页面。');
  const original = notebook.pages[index];
  if (!original) throw new Error('page-missing');
  let source = notebook.source,
    sourceIndex = original.sourceIndex;
  if (sourceIndex !== null) {
    if (!source) throw new Error('pdf-missing');
    const { PDFDocument, PDFDict, PDFName } = await import('pdf-lib');
    const document = await PDFDocument.load(source, { updateMetadata: false });
    const [copy] = await document.copyPages(document, [sourceIndex]);
    const originalAnnotations = document.getPage(sourceIndex).node.Annots();
    // Copied widgets cannot share field identities with the original page.
    // Preserve their visual AP; make the duplicate a static appearance.
    const annotations = copy.node.Annots();
    if (annotations) {
      for (const [i, entry] of annotations.asArray().entries()) {
        const annotation = document.context.lookup(entry);
        const original = originalAnnotations && document.context.lookup(originalAnnotations.get(i));
        // The copier can clone referenced destination page dictionaries outside
        // the page tree. Keep link/action targets bound to the real source pages.
        if (annotation instanceof PDFDict && original instanceof PDFDict)
          for (const key of ['Dest', 'A', 'AA']) {
            const value = original.get(PDFName.of(key));
            if (value) annotation.set(PDFName.of(key), value);
          }
        if (
          annotation instanceof PDFDict &&
          annotation.get(PDFName.of('Subtype')) === PDFName.of('Widget')
        ) {
          annotation.set(PDFName.of('Subtype'), PDFName.of('Stamp'));
          annotation.delete(PDFName.of('Parent'));
          annotation.set(PDFName.of('F'), document.context.obj(4));
        }
      }
    }
    sourceIndex = document.getPageCount();
    document.addPage(copy);
    source = await document.save();
  }
  return {
    ...notebook,
    source,
    pages: [
      ...notebook.pages.slice(0, index + 1),
      clonePage(original, sourceIndex),
      ...notebook.pages.slice(index + 1),
    ],
  };
}
