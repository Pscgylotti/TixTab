import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { PdfiumOutline } from './pdfiumProtocol';
export function nativeDestination(
  api: WrappedPdfiumModule,
  document: number,
  dest: number,
): unknown[] | null {
  if (!dest) return null;
  const page = api.FPDFDest_GetDestPageIndex(document, dest);
  if (page < 0) return null;
  const m = api.pdfium,
    p = m.wasmExports.malloc(32);
  try {
    const mode = api.FPDFDest_GetView(dest, p, p + 4),
      name = ['', 'XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV'][mode];
    if (!name) return [page, { name: 'Fit' }];
    if (name === 'XYZ') {
      for (let i = 0; i < 24; i += 4) m.setValue(p + i, 0, 'i32');
      if (!api.FPDFDest_GetLocationInPage(dest, p, p + 4, p + 8, p + 12, p + 16, p + 20))
        return [page, { name: 'XYZ' }, null, null, null];
      return [
        page,
        { name },
        ...[0, 1, 2].map((i) =>
          m.getValue(p + i * 4, 'i32') ? m.getValue(p + 12 + i * 4, 'float') : null,
        ),
      ];
    }
    const count = Math.min(4, m.getValue(p, 'i32'));
    return [
      page,
      { name },
      ...Array.from({ length: count }, (_, i) => m.getValue(p + 4 + i * 4, 'float')),
    ];
  } finally {
    m.wasmExports.free(p);
  }
}
function target(api: WrappedPdfiumModule, document: number, dest: number, action: number) {
  const resolved = nativeDestination(
    api,
    document,
    dest || (action ? api.FPDFAction_GetDest(document, action) : 0),
  );
  if (resolved) return { dest: resolved };
  if (!action || api.FPDFAction_GetType(action) !== 3) return {};
  const length = api.FPDFAction_GetURIPath(document, action, 0, 0);
  if (length <= 1 || length > 65536) return {};
  const m = api.pdfium,
    p = m.wasmExports.malloc(length);
  try {
    api.FPDFAction_GetURIPath(document, action, p, length);
    return { url: m.UTF8ToString(p, length - 1) };
  } finally {
    m.wasmExports.free(p);
  }
}
export function nativeOutline(api: WrappedPdfiumModule, document: number): PdfiumOutline[] {
  const seen = new Set<number>();
  const children = (parent: number, depth: number): PdfiumOutline[] => {
    const result: PdfiumOutline[] = [];
    if (depth > 64) return result;
    for (
      let item = api.FPDFBookmark_GetFirstChild(document, parent);
      item && !seen.has(item) && seen.size < 4096;
      item = api.FPDFBookmark_GetNextSibling(document, item)
    ) {
      seen.add(item);
      const length = api.FPDFBookmark_GetTitle(item, 0, 0);
      let title = '';
      if (length > 1 && length <= 65536) {
        const m = api.pdfium,
          p = m.wasmExports.malloc(length);
        try {
          api.FPDFBookmark_GetTitle(item, p, length);
          title = m.UTF16ToString(p, length);
        } finally {
          m.wasmExports.free(p);
        }
      }
      result.push({
        title,
        ...target(
          api,
          document,
          api.FPDFBookmark_GetDest(document, item),
          api.FPDFBookmark_GetAction(item),
        ),
        items: children(item, depth + 1),
      });
    }
    return result;
  };
  return children(0, 0);
}
export function nativeLinks(api: WrappedPdfiumModule, document: number, page: number) {
  const result: {
    subtype: 'Link';
    rect: number[];
    quadPoints?: number[];
    dest?: unknown[];
    url?: string;
  }[] = [];
  const m = api.pdfium,
    p = m.wasmExports.malloc(64);
  try {
    m.setValue(p, 0, 'i32');
    while (result.length < 4096 && api.FPDFLink_Enumerate(page, p, p + 4)) {
      const link = m.getValue(p + 4, 'i32');
      if (!api.FPDFLink_GetAnnotRect(link, p + 8)) continue;
      const rect = [0, 3, 2, 1].map((i) => m.getValue(p + 8 + i * 4, 'float'));
      const quadPoints: number[] = [];
      const count = Math.min(4096, api.FPDFLink_CountQuadPoints(link));
      for (let i = 0; i < count; i++)
        if (api.FPDFLink_GetQuadPoints(link, i, p + 24))
          for (let j = 0; j < 8; j++) quadPoints.push(m.getValue(p + 24 + j * 4, 'float'));
      result.push({
        subtype: 'Link',
        rect,
        ...(quadPoints.length ? { quadPoints } : {}),
        ...target(
          api,
          document,
          api.FPDFLink_GetDest(document, link),
          api.FPDFLink_GetAction(link),
        ),
      });
    }
    return result;
  } finally {
    m.wasmExports.free(p);
  }
}
