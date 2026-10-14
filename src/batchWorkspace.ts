import { get, set, del } from 'idb-keyval';
import type { Notebook } from './model';
export interface BatchItem {
  id: string;
  name: string;
  storageId: string;
  edited: boolean;
  cached: boolean;
}
export interface BatchManifest {
  id: string;
  title: string;
  folderId: string;
  items: BatchItem[];
}
export interface BatchBridge {
  run: (request: Record<string, unknown>) => Promise<{
    ok: boolean;
    cancelled?: boolean;
    error?: string;
    token?: string;
    folder?: { id: string; name: string; files: { id: string; name: string }[] };
    bytes?: Uint8Array;
  }>;
}
export const saveBatchManifest = (value: BatchManifest) => set(`tixtab.batch.${value.id}`, value);
export const loadBatchManifest = (id: string) => get<BatchManifest>(`tixtab.batch.${id}`);
export const deleteBatchManifest = (id: string) => del(`tixtab.batch.${id}`);
export function withBatch(notebook: Notebook, manifest: BatchManifest, item: BatchItem): Notebook {
  return { ...notebook, batch: { id: manifest.id, title: manifest.title, itemId: item.id } };
}
export function batchOutputName(name: string) {
  return (
    name
      .replace(/\.pdf$/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 170) + '-annotated.pdf'
  );
}
export async function batchRequest(request: Record<string, unknown>) {
  const bridge = window.surfaceDesktop?.batchPdf;
  if (!bridge) throw Error('desktop-required');
  const result = await bridge.run(request);
  if (!result.ok && !result.cancelled) throw Error(result.error || 'batch-pdf');
  return result;
}
