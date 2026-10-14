import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
export type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
import { performanceLedger, trackPerformance } from './performanceLedger';
import { renderPolicy, subscribeAppearance } from './appearance';

const REUSE_TEXT_CONTENT = true;
const PAGE_LIMIT = 32,
  BYTE_LIMIT = 8_000_000;
type Entry = { promise: Promise<TextContent>; bytes: number };
let documents = new WeakMap<PDFDocumentProxy, Map<number, Entry>>();
subscribeAppearance(() => {
  if (renderPolicy().minimal) documents = new WeakMap();
});

/** Share default PDF.js extraction only. Consumers must treat the returned text
 * as read-only; each visible text layer still owns its DOM and layout. Limits
 * estimate retained source data, not exact JavaScript heap allocation. */
export function readPdfTextContent(pdf: PDFDocumentProxy, index: number, page?: PDFPageProxy) {
  const load = () => {
    performanceLedger?.count('pdfTextExtractions');
    return trackPerformance('pdf-text', () =>
      page ? page.getTextContent() : pdf.getPage(index + 1).then((p) => p.getTextContent()),
    );
  };
  if (!REUSE_TEXT_CONTENT) return load();
  let cache = documents.get(pdf);
  if (!cache) documents.set(pdf, (cache = new Map()));
  const prior = cache.get(index);
  if (prior) {
    cache.delete(index);
    cache.set(index, prior);
    performanceLedger?.count('pdfTextCacheHits');
    return prior.promise;
  }
  const entry: Entry = { promise: load(), bytes: 0 };
  cache.set(index, entry);
  const trim = () => {
    let bytes = [...cache.values()].reduce((total, value) => total + value.bytes, 0);
    while (
      cache.size > (renderPolicy().minimal ? 2 : PAGE_LIMIT) ||
      bytes > (renderPolicy().minimal ? 256000 : BYTE_LIMIT)
    ) {
      const first = cache.keys().next().value!;
      bytes -= cache.get(first)!.bytes;
      cache.delete(first);
    }
  };
  trim();
  void entry.promise.then(
    (content) => {
      if (cache.get(index) !== entry) return;
      entry.bytes =
        content.items.reduce(
          (total, item) => total + 256 + ('str' in item ? item.str.length * 2 : 0),
          0,
        ) +
        Object.entries(content.styles).reduce(
          (total, [name, style]) =>
            total + 256 + (name.length + (style.fontFamily?.length ?? 0)) * 2,
          0,
        );
      trim();
    },
    () => {
      if (cache.get(index) === entry) cache.delete(index);
    },
  );
  return entry.promise;
}
