import { uid, validNotebook, type Page, type PlacedImage } from './model';
import { objectBox } from './objectSelection';

export const OBJECT_MIME = 'application/x-tixtab-objects+json';
const MAX_BYTES = 50_000_000;
interface ObjectClipboard {
  type: 'tixtab-objects';
  version: 1;
  pageId: string;
  objects: PlacedImage[];
}
export function encodeObjects(page: Page, ids: readonly string[]) {
  const chosen = new Set(ids);
  return JSON.stringify({
    type: 'tixtab-objects',
    version: 1,
    pageId: page.id,
    objects: page.images.filter((i) => chosen.has(i.id)),
  } satisfies ObjectClipboard);
}
/** Clipboard data is untrusted. Apply project validation and explicit size/geometry limits. */
export function decodeObjects(raw: string): ObjectClipboard | null {
  if (!raw || raw.length > MAX_BYTES) return null;
  try {
    const value = JSON.parse(raw) as ObjectClipboard;
    if (
      value?.type !== 'tixtab-objects' ||
      value.version !== 1 ||
      typeof value.pageId !== 'string' ||
      !Array.isArray(value.objects) ||
      !value.objects.length ||
      value.objects.length > 1000 ||
      value.objects.some(
        (i) =>
          !i ||
          typeof i.id !== 'string' ||
          [i.x, i.y, i.width, i.height].some((n) => !Number.isFinite(n) || Math.abs(n) > 100_000) ||
          (i.latex !== undefined && (typeof i.latex !== 'string' || i.latex.length > 100_000)),
      )
    )
      return null;
    const valid = validNotebook({
      version: 1,
      name: 'clipboard',
      source: null,
      pages: [
        {
          id: 'clipboard',
          sourceIndex: null,
          width: 600,
          height: 900,
          paper: 'plain',
          strokes: [],
          images: value.objects,
        },
      ],
    });
    return valid ? value : null;
  } catch {
    return null;
  }
}
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function objectsFromClipboard(data: Pick<DataTransfer, 'getData'>) {
  const direct = decodeObjects(data.getData(OBJECT_MIME));
  if (direct) return direct;
  const html = data.getData('text/html');
  if (!html || html.length > MAX_BYTES * 2) return null;
  // Parse only the quoted data attribute, avoiding unrelated clipboard HTML/resources.
  const attribute = html.match(/\bdata-tixtab-objects\s*=\s*("[^"]*"|'[^']*')/i);
  if (!attribute) return null;
  const raw = new DOMParser()
    .parseFromString(`<span data-tixtab-objects=${attribute[1]}></span>`, 'text/html')
    .querySelector('[data-tixtab-objects]')
    ?.getAttribute('data-tixtab-objects');
  return raw ? decodeObjects(raw) : null;
}
export async function copyObjects(page: Page, ids: readonly string[]) {
  const raw = encodeObjects(page, ids),
    payload = decodeObjects(raw);
  if (!payload) throw new Error('无法复制所选对象');
  const text = payload.objects
    .map((i) => i.textBox?.content || i.latex || `[TixTab ${i.kind}]`)
    .join('\n');
  const html = `<span data-tixtab-objects="${escapeHtml(raw)}">${escapeHtml(text)}</span>`;
  // HTML carries editable data across real Windows clipboard operations; plain text stays useful in other apps.
  let written = false;
  const copy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData(OBJECT_MIME, raw);
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', text);
    written = true;
  };
  document.addEventListener('copy', copy, true);
  try {
    if (document.execCommand('copy') && written) return;
  } finally {
    document.removeEventListener('copy', copy, true);
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    }),
  ]);
}
/** Toolbar paste uses the same event path as Ctrl+V; ordinary field paste is never intercepted. */
export async function pasteObjectsFromButton() {
  const items = await navigator.clipboard.read();
  const data = new DataTransfer();
  for (const item of items) {
    for (const type of ['text/html', 'text/plain']) {
      if (item.types.includes(type)) data.setData(type, await (await item.getType(type)).text());
    }
  }
  if (!objectsFromClipboard(data)) throw new Error('剪贴板中没有可粘贴的 TixTab 对象');
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
}
export function placeClipboardObjects(
  payload: ObjectClipboard,
  page: Page,
  anchor?: { pageId?: string; x?: number; y?: number },
  offset = 16,
) {
  const box = objectBox(
    payload.objects,
    payload.objects.map((i) => i.id),
  )!;
  const scale = Math.min(1, (page.width * 0.9) / box.width, (page.height * 0.9) / box.height);
  const width = box.width * scale,
    height = box.height * scale;
  const x = Math.max(
    0,
    Math.min(
      page.width - width,
      anchor?.x !== undefined
        ? anchor.x - width / 2 + offset
        : payload.pageId === page.id
          ? box.x + offset
          : (page.width - width) / 2 + offset - 16,
    ),
  );
  const y = Math.max(
    0,
    Math.min(
      page.height - height,
      anchor?.y !== undefined
        ? anchor.y - height / 2 + offset
        : payload.pageId === page.id
          ? box.y + offset
          : (page.height - height) / 2 + offset - 16,
    ),
  );
  return payload.objects.map((original) => ({
    ...structuredClone(original),
    id: uid(),
    x: x + (original.x - box.x) * scale,
    y: y + (original.y - box.y) * scale,
    width: original.width * scale,
    height: original.height * scale,
  }));
}
