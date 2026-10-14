import { extractPage } from './pageTransferEngine';
import { appendPdfSources } from './pdfInsertion';
import type { CopiedPage } from './pageTransferEngine';
import type { Page } from './model';
const scope = self as unknown as {
  onmessage:
    | ((
        e: MessageEvent<{
          action: 'copy' | 'paste';
          source: Uint8Array | null;
          page?: Page;
          payload?: CopiedPage;
        }>,
      ) => void)
    | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    const result =
      data.action === 'copy'
        ? await extractPage(data.source, data.page!)
        : await appendPdfSources(data.source, [{ bytes: data.payload!.source!, pages: [0] }]);
    scope.postMessage(
      { ok: true, result },
      result.source ? [result.source.buffer as ArrayBuffer] : [],
    );
  } catch (e) {
    scope.postMessage({ ok: false, error: e instanceof Error ? e.message : 'page-transfer' });
  }
};
