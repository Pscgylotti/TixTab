import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ source: Uint8Array }>) => void) | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    const source = await PDFDocument.load(data.source, { updateMetadata: false });
    if (source.getForm().getFields().length)
      source.getForm().flatten({ updateFieldAppearances: false });
    for (let i = 0; i < source.getPageCount(); i++) {
      const doc = await PDFDocument.create(),
        [page] = await doc.copyPages(source, [i]);
      doc.addPage(page);
      const annotations = page.node.Annots();
      for (const ref of annotations?.asArray() ?? []) {
        const a = doc.context.lookup(ref);
        if (!(a instanceof PDFDict)) continue;
        // A single-page file cannot navigate to absent pages. Keep URI/mailto.
        a.delete(PDFName.of('Dest'));
        const action = a.lookupMaybe(PDFName.of('A'), PDFDict);
        if (action?.get(PDFName.of('S')) === PDFName.of('GoTo')) a.delete(PDFName.of('A'));
      }
      const bytes = await doc.save({ updateFieldAppearances: false });
      scope.postMessage({ index: i, bytes: bytes.buffer, total: source.getPageCount() }, [
        bytes.buffer as ArrayBuffer,
      ]);
    }
    scope.postMessage({ done: true });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : 'split-failed' });
  }
};
