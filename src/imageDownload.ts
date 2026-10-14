const pending = new Map<string, ReturnType<typeof setTimeout>>();
function release(url: string) {
  clearTimeout(pending.get(url));
  pending.delete(url);
  URL.revokeObjectURL(url);
}
/** Download URLs own decoded/encoded image memory. Bound both count and lifetime. */
export function saveImageBlob(blob: Blob, name: string) {
  while (pending.size >= 2) release(pending.keys().next().value!);
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  pending.set(
    url,
    setTimeout(() => release(url), 10_000),
  );
  try {
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
  } catch (error) {
    release(url);
    throw error;
  } finally {
    a.remove();
  }
}
export function releaseImageDownloads() {
  for (const url of pending.keys()) release(url);
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', releaseImageDownloads);
export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (canvas.width < 1 || canvas.height < 1) return reject(Error('image-not-ready'));
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(Error('image-encode'))), 'image/png');
  });
}
