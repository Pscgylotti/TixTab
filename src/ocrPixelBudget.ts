/** Budget the expensive WASM working sets. Four small pictures may run
 * together; four 4MP scans may not, even when four workers were requested. */
export function ocrInputPixels(image: string) {
  try {
    const prefix = 'data:image/png;base64,';
    if (!image.startsWith(prefix)) return 4_000_000;
    const raw = atob(image.slice(prefix.length, prefix.length + 44));
    if (raw.slice(1, 4) !== 'PNG' || raw.slice(12, 16) !== 'IHDR') return 4_000_000;
    const n = (i: number) =>
      raw.charCodeAt(i) * 16777216 +
      raw.charCodeAt(i + 1) * 65536 +
      raw.charCodeAt(i + 2) * 256 +
      raw.charCodeAt(i + 3);
    return Math.max(1, Math.min(4_000_000, n(16) * n(20) || 4_000_000));
  } catch {
    return 4_000_000;
  }
}
export function createOcrPixelBudget(limit = 4_000_000) {
  let used = 0;
  const queue: {
    pixels: number;
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    abort: () => void;
  }[] = [];
  const pump = () => {
    while (queue.length && used + queue[0].pixels <= limit) {
      const item = queue.shift()!;
      item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) {
        item.reject(item.signal.reason);
        continue;
      }
      used += item.pixels;
      let done = false;
      item.resolve(() => {
        if (!done) {
          done = true;
          used -= item.pixels;
          pump();
        }
      });
    }
  };
  return (pixels: number, signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item = {
        pixels: Math.max(1, Math.min(limit, pixels)),
        signal,
        resolve,
        reject,
        abort: () => {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
          reject(signal.reason);
          pump();
        },
      };
      signal.addEventListener('abort', item.abort, { once: true });
      queue.push(item);
      pump();
    });
  };
}
