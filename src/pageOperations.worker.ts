import { operatePages } from './pageOperationsEngine';
import type { PageOperation } from './pageOperations';
import type { Notebook } from './model';
const scope = self as unknown as {
  onmessage:
    | ((
        event: MessageEvent<{ notebook: Notebook; indices: number[]; operation: PageOperation }>,
      ) => void)
    | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    const result = await operatePages(data.notebook, data.indices, data.operation);
    scope.postMessage(
      { ok: true, notebook: result },
      result.source ? [result.source.buffer as ArrayBuffer] : [],
    );
  } catch (e) {
    scope.postMessage({ ok: false, error: e instanceof Error ? e.message : 'page-edit' });
  }
};
