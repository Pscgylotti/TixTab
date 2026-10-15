import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';

/** PDFium does not expose /ImageMask on page objects. Prove that ordinary
 * occurrence enumeration is safe without asking its DIB metadata decoder.
 * Uncertain documents keep the existing geometry-only compatibility index. */
export async function nativeImageSupport(doc: PDFDocument, check: () => void) {
  const objects = doc.context.enumerateIndirectObjects();
  const pending: unknown[] = objects.map(([, object]) => object),
    seen = new WeakSet<object>();
  while (pending.length) {
    const obj = pending.pop();
    if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
    seen.add(obj);
    if (obj instanceof PDFRawStream) {
      pending.push(obj.dict);
      continue;
    }
    if (obj instanceof PDFArray) {
      pending.push(...obj.asArray());
      continue;
    }
    if (!(obj instanceof PDFDict)) continue;
    for (const [, value] of obj.entries()) pending.push(value);
    const subtype = obj.lookup(PDFName.of('Subtype'));
    if (
      subtype !== PDFName.of('Image') &&
      (obj.lookup(PDFName.of('Type')) === PDFName.of('ExtGState') ||
        ['ca', 'SMask', 'BM', 'TR', 'TR2'].some((key) => obj.has(PDFName.of(key))))
    ) {
      const ca = obj.lookup(PDFName.of('ca')),
        opacity = ca instanceof PDFNumber ? ca.asNumber() : 1,
        mask = obj.lookup(PDFName.of('SMask')),
        blend = obj.lookup(PDFName.of('BM'));
      // Source extraction must not bake page-level opacity/blending/masks into
      // the image. Soft masks on image streams themselves remain supported.
      if (
        opacity !== 1 ||
        (mask && mask !== PDFName.of('None')) ||
        (blend && blend !== PDFName.of('Normal') && blend !== PDFName.of('Compatible')) ||
        obj.has(PDFName.of('TR')) ||
        obj.has(PDFName.of('TR2'))
      )
        return doc.getPages().map(() => false);
    }
    const mask = obj.lookup(PDFName.of('ImageMask')) ?? obj.lookup(PDFName.of('IM'));
    if (mask instanceof PDFBool && mask.asBoolean()) return doc.getPages().map(() => false);
  }
  let budget = 8_000_000;
  const inspected = new WeakMap<PDFRawStream, Promise<boolean>>();
  const unsafe = (stream: PDFRawStream): Promise<boolean> => {
    const prior = inspected.get(stream);
    if (prior) return prior;
    const result = (async () => {
      check();
      const bytes = stream.contents;
      if (bytes.length > 1_000_000 || budget <= 0) return true;
      const filter = stream.dict.lookup(PDFName.of('Filter'));
      const name = filter instanceof PDFArray && filter.size() === 1 ? filter.lookup(0) : filter;
      if (
        name &&
        (!(name instanceof PDFName) || !['/FlateDecode', '/Fl'].includes(name.toString()))
      )
        return true;
      if (stream.dict.has(PDFName.of('DecodeParms'))) return true;
      const input = new Blob([new Uint8Array(bytes)]).stream();
      const reader = (
        name ? input.pipeThrough(new DecompressionStream('deflate')) : input
      ).getReader();
      let tail = '',
        size = 0;
      const decoder = new TextDecoder('latin1');
      try {
        for (;;) {
          const { value, done } = await reader.read();
          check();
          if (done) return false;
          size += value.byteLength;
          budget -= value.byteLength;
          if (size > 2_000_000 || budget < 0) return true;
          const text = tail + decoder.decode(value);
          // Conservatively reject any possible inline image, including a false
          // positive inside a string. No inline image bytes need to be decoded.
          if (/(?:^|[\s\x00()<>\[\]{}/%])BI(?=$|[\s\x00()<>\[\]{}/%])/.test(text)) return true;
          tail = text.slice(-4);
        }
      } catch (error) {
        check();
        return true;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    })();
    inspected.set(stream, result);
    return result;
  };
  for (const [, obj] of objects) {
    if (
      obj instanceof PDFRawStream &&
      obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Form') &&
      (await unsafe(obj))
    )
      return doc.getPages().map(() => false);
  }
  const support: boolean[] = [];
  for (const page of doc.getPages()) {
    check();
    const annotations = page.node.Annots();
    let compatible = true;
    if (annotations)
      for (let i = 0; i < annotations.size(); i++) {
        const annotation = annotations.lookup(i);
        if (annotation instanceof PDFDict && annotation.has(PDFName.of('AP'))) compatible = false;
      }
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i))
        : [contents];
    for (const stream of streams)
      if (stream instanceof PDFRawStream && (await unsafe(stream))) compatible = false;
    support.push(compatible);
  }
  return support;
}
