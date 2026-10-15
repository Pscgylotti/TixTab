import { PDFDocument, PDFName, PDFNumber, ParseSpeeds } from 'pdf-lib';
import type { PdfiumPageInfo } from './pdfiumProtocol';
/** The public PDFium ABI does not expose /UserUnit. Read dictionary attributes
 * in this Worker with the existing export library, then discard its object graph.
 * No image decoding, text extraction or second persistent document is created. */
export async function sourcePageGeometry(bytes: Uint8Array): Promise<PdfiumPageInfo[]> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    parseSpeed: ParseSpeeds.Fastest,
  });
  return doc.getPages().map((page) => {
    const media = page.getMediaBox(),
      crop = page.getCropBox();
    const box = (r: typeof media) => [
      Math.min(r.x, r.x + r.width),
      Math.min(r.y, r.y + r.height),
      Math.max(r.x, r.x + r.width),
      Math.max(r.y, r.y + r.height),
    ];
    const a = box(media),
      b = box(crop);
    let view = [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.min(a[3], b[3]),
    ];
    if (view[2] <= view[0] || view[3] <= view[1]) view = a;
    const unit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1;
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    return {
      view,
      rotation: angle % 90 ? 0 : angle,
      userUnit: Number.isFinite(unit) && unit > 0 ? unit : 1,
      objectNumber: page.ref.objectNumber,
    };
  });
}
