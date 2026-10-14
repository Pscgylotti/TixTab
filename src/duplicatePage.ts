import { uid, type Notebook, type Page, type PlacedImage } from './model';
export function clonePage(page: Page, sourceIndex = page.sourceIndex): Page {
  const cloneImage = (image: PlacedImage): PlacedImage => ({
    ...structuredClone(image),
    id: uid(),
    ...(image.group
      ? { group: { ...image.group, objects: image.group.objects.map(cloneImage) } }
      : {}),
  });
  return {
    ...page,
    id: uid(),
    sourceIndex,
    strokes: page.strokes.map((s) => ({ ...s, id: uid(), points: s.points.map((p) => [...p]) })),
    images: page.images.map(cloneImage),
  };
}
/** Give a duplicate its own source page, so export never aliases one PDF page twice. */
export async function duplicateNotebookPage(notebook: Notebook, index: number): Promise<Notebook> {
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
