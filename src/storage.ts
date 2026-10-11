import { get, set } from 'idb-keyval';
import { validNotebook, type Notebook } from './model';
export const autosave = (notebook: Notebook) => set('surfacetab-notebook-v1', notebook);
export async function restore() {
  const n = await get('surfacetab-notebook-v1');
  return validNotebook(n) ? n : null;
}
export function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function encodeProject(n: Notebook) {
  let binary = '';
  if (n.source)
    for (let i = 0; i < n.source.length; i += 32768)
      binary += String.fromCharCode(...n.source.subarray(i, i + 32768));
  return JSON.stringify({ ...n, source: n.source ? btoa(binary) : null });
}
export function decodeProject(text: string): Notebook {
  const value = JSON.parse(text);
  if (!validNotebook(value)) throw new Error('工程文件格式不正确或版本不支持');
  const encoded = (value as unknown as { source: unknown }).source;
  if (encoded !== null && typeof encoded !== 'string') throw new Error('PDF 数据无效');
  value.source =
    typeof encoded === 'string' ? Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)) : null;
  if (value.pages.some((p) => p.sourceIndex !== null) && !value.source)
    throw new Error('工程缺少原始 PDF');
  return value;
}
