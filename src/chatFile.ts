export const MAX_CHAT_PDF_BYTES = 50_000_000;
/** Bounded text-only context for endpoints without native PDF input. Never silently claim full coverage. */
export async function originalPdfText(source: Uint8Array | null, signal: AbortSignal) {
  if (!source) throw new Error('invalid');
  signal.throwIfAborted();
  const { loadPdf } = await import('./pdf');
  const pdf = await loadPdf(new Uint8Array(source));
  try {
    const chunks: string[] = [];
    let remaining = 100000,
      readPages = 0,
      truncated = false,
      hasText = false;
    for (let i = 1; i <= pdf.numPages; i++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(i);
      const text = await page.getTextContent();
      signal.throwIfAborted();
      const value = text.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('');
      hasText ||= !!value.trim();
      chunks.push(`[Original PDF page ${i}]\n${value.slice(0, remaining)}`);
      readPages = i;
      remaining -= value.length;
      page.cleanup();
      if (remaining <= 0) {
        truncated = true;
        break;
      }
    }
    if (!hasText) {
      const { ProviderInputError } = await import('./remoteProvider');
      const { t } = await import('./i18n');
      throw new ProviderInputError(
        t('原 PDF 没有可提取文字，请附加页面图片、使用 OCR 或选择支持 PDF 的模型。'),
      );
    }
    return `[Original PDF text: ${readPages} of ${pdf.numPages} pages${truncated ? '; truncated at 100000 characters. Explain this limitation; do not claim to summarize unseen content' : ''}. Images and handwritten annotations are not included.]\n\n${chunks.join('\n\n')}`;
  } finally {
    await pdf.destroy();
  }
}
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
