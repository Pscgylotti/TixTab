export async function renderColorKey(
  data: string,
  color: string,
  tolerance: number,
  signal: AbortSignal,
  edge = 8192,
): Promise<string> {
  signal.throwIfAborted();
  if (
    !/^#[0-9a-f]{6}$/i.test(color) ||
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 255
  )
    throw Error('color-key');
  const blob = await (await fetch(data, { signal })).blob();
  signal.throwIfAborted();
  const worker = new Worker(new URL('./colorKey.worker.ts', import.meta.url), { type: 'module' });
  let abort: () => void = () => {};
  try {
    const result = await new Promise<Blob>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('timeout')), 30000);
      const fail = (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      };
      abort = () => fail(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = () => fail(Error('color-key'));
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        data.blob ? resolve(data.blob) : reject(Error(data.error));
      };
      worker.postMessage({ blob, color, tolerance, edge });
    });
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const stop = () => reader.abort();
      signal.addEventListener('abort', stop, { once: true });
      reader.onload = () => {
        signal.removeEventListener('abort', stop);
        resolve(String(reader.result));
      };
      reader.onerror = reader.onabort = () => {
        signal.removeEventListener('abort', stop);
        reject(Error('color-key'));
      };
      reader.readAsDataURL(result);
    });
  } finally {
    signal.removeEventListener('abort', abort);
    worker.terminate();
  }
}
