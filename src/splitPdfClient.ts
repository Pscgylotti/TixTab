const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
async function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let p = 0; p < data.length; p += 1024 * 1024) {
    for (let i = p; i < Math.min(data.length, p + 1024 * 1024); i++)
      crc = crcTable[(crc ^ data[i]) & 255] ^ (crc >>> 8);
    if (p) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Store already compressed PDF streams in ZIP without another compression pass. */
export async function splitPdfZip(
  source: Uint8Array,
  base: string,
  signal: AbortSignal,
  onProgress: (i: number, total: number) => void,
): Promise<Blob> {
  const files: { index: number; bytes: Uint8Array }[] = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./splitPdf.worker.ts', import.meta.url), { type: 'module' });
    const results: { index: number; bytes: Uint8Array }[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(results);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.onerror = () => finish(Error('split-failed'));
    worker.onmessage = ({ data }) => {
      if (data.error) finish(Error('split-failed'));
      else if (data.done) finish();
      else {
        size += data.bytes.byteLength;
        if (size > 256 * 1024 * 1024) {
          finish(Error('split-large'));
          return;
        }
        results.push({ index: data.index, bytes: new Uint8Array(data.bytes) });
        onProgress(results.length, data.total);
      }
    };
    worker.postMessage({ source });
  });
  const parts: BlobPart[] = [],
    directory: BlobPart[] = [];
  let offset = 0,
    directorySize = 0;
  for (const file of files) {
    signal.throwIfAborted();
    const filename = new TextEncoder().encode(
      `${base.replace(/[\\/:*?"<>|]/g, '_')}-${file.index + 1}.pdf`,
    );
    const crc = await crc32(file.bytes),
      size = file.bytes.length;
    const header = new Uint8Array(30 + filename.length),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, size, true);
    h.setUint32(22, size, true);
    h.setUint16(26, filename.length, true);
    header.set(filename, 30);
    parts.push(header, file.bytes as Uint8Array<ArrayBuffer>);
    const central = new Uint8Array(46 + filename.length),
      c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, filename.length, true);
    c.setUint32(42, offset, true);
    central.set(filename, 46);
    directory.push(central);
    directorySize += central.length;
    offset += header.length + size;
  }
  const end = new Uint8Array(22),
    view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
