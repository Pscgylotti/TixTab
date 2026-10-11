export const MAX_CHAT_PDF_BYTES = 50_000_000;
/** Browser-native encoding keeps large base64 conversions off the JavaScript loop. */
export function originalPdfFile(
  source: Uint8Array | null,
  name: string,
  signal: AbortSignal,
): Promise<{ name: string; data: string }> {
  if (!source) return Promise.reject(new Error('invalid'));
  if (source.byteLength >= MAX_CHAT_PDF_BYTES) return Promise.reject(new Error('file-limit'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader(),
      cancel = () => reader.abort();
    const clean = () => signal.removeEventListener('abort', cancel);
    reader.onerror = () => {
      clean();
      reject(new Error('invalid'));
    };
    reader.onabort = () => {
      clean();
      reject(new Error('cancelled'));
    };
    reader.onload = () => {
      clean();
      let filename = name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 240);
      if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
      resolve({ name: filename || 'document.pdf', data: String(reader.result) });
    };
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    reader.readAsDataURL(new Blob([new Uint8Array(source)], { type: 'application/pdf' }));
  });
}
