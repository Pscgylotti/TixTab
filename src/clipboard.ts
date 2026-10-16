import { browserShelf, rememberClipboard } from './clipboardShelf';
import { canvasPng } from './imageDownload';
export async function copyCanvasImage(canvas: HTMLCanvasElement, signal: AbortSignal) {
  signal.throwIfAborted();
  const png = canvasPng(canvas).then((blob) => {
    signal.throwIfAborted();
    return blob;
  });
  // Begin the clipboard write in the click handler to preserve user activation.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  if (signal.aborted || window.surfaceDesktop?.clipboardShelf) return;
  const blob = await png,
    shelf = await browserShelf.run('list');
  // The browser fallback needs a data URL; avoid allocating one that could
  // never fit its memory budget. Desktop OS history records the PNG directly.
  if (!shelf || (blob.size * 8) / 3 + 2048 > shelf.limit || signal.aborted) return;
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reader.onabort = () => reject(Error('image-copy-cancelled'));
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(blob);
  });
  if (!signal.aborted) rememberClipboard({ text: '', html: '', image });
}
export async function copyImage(data: string) {
  const response = await fetch(data);
  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  rememberClipboard({ text: '', html: '', image: data });
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    rememberClipboard({ text, html: '', image: '' });
    return;
  } catch {
    /* Older desktop sessions may deny clipboard permissions. */
  }
  const selection = window.getSelection(),
    ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
      : [];
  const active = document.activeElement as HTMLElement | null,
    field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  try {
    if (!document.execCommand('copy')) throw new Error('剪贴板不可用');
    rememberClipboard({ text, html: '', image: '' });
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
