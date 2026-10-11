export type BrowserCacheId = 'browser-transformers' | 'browser-tesseract' | 'browser-piper';
export interface CacheRow {
  id: string;
  bytes: number;
  files: number;
  unknownBytes?: number;
  preserved?: number;
  links?: number;
  token?: string;
  error?: string;
}
const voices = ['en_US-lessac-low', 'zh_CN-huayan-x_low'];
const piperNames = new Set(voices.flatMap((voice) => [`${voice}.onnx`, `${voice}.onnx.json`]));
const ocrKeys = new Set([
  './eng.traineddata',
  './chi_sim.traineddata',
  'eng.traineddata',
  'chi_sim.traineddata',
]);
type Directory = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};
async function ocrDatabase(): Promise<IDBDatabase | null> {
  if (!indexedDB.databases) return null;
  if (!(await indexedDB.databases()).some((db) => db.name === 'keyval-store')) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('keyval-store');
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function tesseract(clear: boolean, signal?: AbortSignal) {
  const db = await ocrDatabase();
  let files = 0,
    preserved = 0;
  if (!db) return { files, preserved };
  try {
    if (!db.objectStoreNames.contains('keyval')) return { files, preserved };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('keyval', clear ? 'readwrite' : 'readonly'),
        store = transaction.objectStore('keyval');
      const abort = () => transaction.abort();
      signal?.addEventListener('abort', abort, { once: true });
      transaction.oncomplete = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        signal?.removeEventListener('abort', abort);
        reject(transaction.error ?? new DOMException('Cancelled', 'AbortError'));
      };
      const request = store.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === 'string' && ocrKeys.has(cursor.key)) {
          files++;
          if (clear) store.delete(cursor.key);
        } else preserved++;
        cursor.continue();
      };
      if (signal?.aborted) transaction.abort();
    });
    return { files, preserved };
  } finally {
    db.close();
  }
}
async function piperDirectory() {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle('piper');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}
export async function listBrowserCaches(signal: AbortSignal): Promise<CacheRow[]> {
  const rows: CacheRow[] = [];
  for (const id of ['browser-transformers', 'browser-tesseract', 'browser-piper'] as const) {
    signal.throwIfAborted();
    const row: CacheRow = { id, bytes: 0, files: 0 };
    try {
      if (id === 'browser-transformers') {
        if (await caches.has('transformers-cache')) {
          const cache = await caches.open('transformers-cache');
          for (const request of await cache.keys()) {
            signal.throwIfAborted();
            const response = await cache.match(request),
              length = response?.headers.get('content-length');
            row.files++;
            if (length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)))
              row.bytes += Number(length);
            else row.unknownBytes = (row.unknownBytes ?? 0) + 1;
          }
        }
      } else if (id === 'browser-tesseract') {
        Object.assign(row, await tesseract(false, signal));
        row.unknownBytes = row.files;
      } else {
        const directory = await piperDirectory();
        if (directory)
          for await (const [name, handle] of (directory as Directory).entries()) {
            signal.throwIfAborted();
            if (handle.kind === 'file' && piperNames.has(name)) {
              row.files++;
              row.bytes += (await (handle as FileSystemFileHandle).getFile()).size;
            } else row.preserved = (row.preserved ?? 0) + 1;
          }
      }
    } catch {
      signal.throwIfAborted();
      row.error = 'unavailable';
    }
    rows.push(row);
  }
  return rows;
}
export async function clearBrowserCache(id: BrowserCacheId, signal: AbortSignal) {
  signal.throwIfAborted();
  if (id === 'browser-transformers') {
    await caches.delete('transformers-cache');
  } else if (id === 'browser-tesseract') {
    await tesseract(true, signal);
  } else if (id === 'browser-piper') {
    const directory = await piperDirectory();
    if (directory)
      for (const name of piperNames) {
        signal.throwIfAborted();
        try {
          await directory.removeEntry(name);
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
        }
      }
  } else throw new Error('invalid');
  signal.throwIfAborted();
}
