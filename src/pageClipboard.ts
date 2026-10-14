import { useSyncExternalStore } from 'react';
import { copyText } from './clipboard';
import { uid } from './model';
import { PAGE_CLIPBOARD_LIMIT, pageMemory } from './pageTransfer';
import type { CopiedPage } from './pageTransferEngine';
let payload: CopiedPage | null = null,
  marker = '',
  bytes = 0;
const listeners = new Set<() => void>();
export function pageClipboardStats() {
  return { entries: payload ? 1 : 0, bytes };
}
export function clearPageClipboard() {
  payload = null;
  marker = '';
  bytes = 0;
  listeners.forEach((fn) => fn());
}
export function getCopiedPage() {
  return payload;
}
export function usePageClipboard() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => !!payload,
  );
}
export function pageFromClipboard(data: Pick<DataTransfer, 'getData'>) {
  return marker && data.getData('text/plain') === marker ? payload : null;
}
export function isPageClipboardToken(text: string) {
  return /^TixTab page [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}
export async function storeCopiedPage(next: CopiedPage, signal?: AbortSignal) {
  const size =
    (next.pages || [next.page]).reduce((sum, page) => sum + pageMemory(page), 0) +
    (next.source?.byteLength ?? 0);
  if (size > PAGE_CLIPBOARD_LIMIT) throw Error('page-clipboard-large');
  const token = `TixTab page ${uid()}`;
  // Only a session token reaches the OS clipboard. No whole-PDF/base64 copies.
  let system = true;
  try {
    await copyText(token);
  } catch {
    system = false;
  }
  signal?.throwIfAborted();
  payload = next;
  marker = token;
  bytes = size;
  listeners.forEach((fn) => fn());
  return system;
}
