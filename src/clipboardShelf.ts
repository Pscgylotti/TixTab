import { objectsFromClipboard } from './objectClipboard';
import { inkFromClipboard, inkBox } from './inkSelection';
export interface ClipboardSummary {
  id: string;
  kind: 'text' | 'image' | 'objects' | 'ink';
  text: string;
  preview: string;
  count: number;
  width?: number;
  height?: number;
}
export interface ClipboardPayload {
  text: string;
  html: string;
  image: string;
}
export interface ClipboardSnapshot {
  entries: ClipboardSummary[];
  bytes: number;
  limit: number;
  total: number;
  offset: number;
  paused: boolean;
}
export interface ClipboardShelfBridge {
  run: {
    (action: 'list', offset?: number): Promise<ClipboardSnapshot | null>;
    (action: 'clear'): Promise<ClipboardSnapshot | null>;
    (action: 'pause' | 'memory', value: boolean): Promise<ClipboardSnapshot | null>;
    (action: 'remove', value: string): Promise<ClipboardSnapshot | null>;
    (action: 'get', value: string): Promise<ClipboardPayload | null>;
  };
  onChanged: (callback: () => void) => () => void;
}
// Browser fallback keeps only this session's copies; desktop owns the real OS history.
const entries: { summary: ClipboardSummary; payload: ClipboardPayload; bytes: number }[] = [];
const listeners = new Set<() => void>();
let paused = false,
  bytes = 0,
  limit = 128 * 1024 * 1024,
  epoch = 0;
export function rememberClipboard(payload: ClipboardPayload) {
  if (window.surfaceDesktop?.clipboardShelf || paused) return;
  const size = (payload.text.length + payload.html.length + payload.image.length) * 2;
  if (!size || size + 2048 > limit || /^TixTab page [0-9a-f-]{36}$/i.test(payload.text)) return;
  const existing = entries.findIndex(
    (e) =>
      e.payload.text === payload.text &&
      e.payload.html === payload.html &&
      e.payload.image === payload.image,
  );
  if (existing === 0) return;
  if (existing > 0) entries.unshift(entries.splice(existing, 1)[0]);
  else {
    const data = new DataTransfer();
    data.setData('text/html', payload.html);
    const objects = objectsFromClipboard(data),
      ink = inkFromClipboard(data);
    let preview = payload.image;
    if (objects) preview = objects.objects[0].displayData || objects.objects[0].data;
    if (ink) {
      const box = inkBox(ink.strokes)!;
      const lines = ink.strokes
        .slice(0, 80)
        .map((s) => {
          const points = s.points.filter(
            (_, i) => i % Math.max(1, Math.ceil(s.points.length / 64)) === 0,
          );
          const color = /^#[a-f0-9]{3,8}$/i.test(s.color) ? s.color : '#477dd5';
          return `<polyline fill="none" stroke="${color}" stroke-width="${s.size}" stroke-linecap="round" points="${points.map((p) => `${p[0]},${p[1]}`).join(' ')}"/>`;
        })
        .join('');
      preview = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.minX - 4} ${box.minY - 4} ${box.maxX - box.minX + 8} ${box.maxY - box.minY + 8}">${lines}</svg>`)}`;
    }
    const summary: ClipboardSummary = {
      id: crypto.randomUUID(),
      kind: objects ? 'objects' : ink ? 'ink' : payload.image ? 'image' : 'text',
      text: payload.text.slice(0, 600),
      preview,
      count: objects?.objects.length || ink?.strokes.length || 1,
    };
    // Preview shares its source string; no additional full-size raster or canvas stays alive.
    const cost = size + (summary.text.length + (ink ? preview.length : 0)) * 2 + 768;
    if (cost > limit) return;
    while (entries.length && bytes + cost > limit) bytes -= entries.pop()!.bytes;
    entries.unshift({ summary, payload, bytes: cost });
    bytes += cost;
  }
  listeners.forEach((fn) => fn());
}
export const browserShelf: ClipboardShelfBridge = {
  run: (async (action: string, value?: string | boolean | number) => {
    if (action === 'get') return entries.find((e) => e.summary.id === value)?.payload ?? null;
    if (action === 'clear') {
      epoch++;
      entries.length = 0;
      bytes = 0;
    }
    if (action === 'remove') {
      const at = entries.findIndex((e) => e.summary.id === value);
      if (at >= 0) bytes -= entries.splice(at, 1)[0].bytes;
    }
    if (action === 'pause' && typeof value === 'boolean') {
      epoch++;
      paused = value;
    }
    if (action === 'memory' && typeof value === 'boolean') {
      epoch++;
      limit = (value ? 32 : 128) * 1024 * 1024;
      while (entries.length && bytes > limit) bytes -= entries.pop()!.bytes;
    }
    if (action !== 'list') listeners.forEach((fn) => fn());
    const offset =
      action === 'list' && typeof value === 'number' && Number.isInteger(value)
        ? Math.max(0, Math.min(value, Math.max(0, Math.ceil(entries.length / 40) - 1) * 40))
        : 0;
    return {
      entries: entries.slice(offset, offset + 40).map((e) => e.summary),
      bytes,
      limit,
      total: entries.length,
      offset,
      paused,
    };
  }) as ClipboardShelfBridge['run'],
  onChanged(callback) {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
export function startClipboardCapture() {
  const capture = (event: ClipboardEvent) => {
    if (event.target instanceof Element && event.target.closest('input[type=password]')) return;
    const data = event.clipboardData;
    if (data)
      rememberClipboard({
        text: data.getData('text/plain'),
        html: data.getData('text/html'),
        image: '',
      });
  };
  window.addEventListener('copy', capture);
  window.addEventListener('cut', capture);
  return () => {
    window.removeEventListener('copy', capture);
    window.removeEventListener('cut', capture);
  };
}
export async function readCurrentClipboard() {
  if (window.surfaceDesktop?.clipboardShelf || paused) return;
  const generation = epoch;
  try {
    const payload: ClipboardPayload = { text: '', html: '', image: '' };
    for (const item of (await navigator.clipboard.read()).slice(0, 1)) {
      for (const type of ['text/plain', 'text/html', 'image/png']) {
        if (!item.types.includes(type)) continue;
        const blob = await item.getType(type);
        if (blob.size > limit / 3) continue;
        if (type === 'text/plain') payload.text = await blob.text();
        if (type === 'text/html') payload.html = await blob.text();
        if (type === 'image/png')
          payload.image = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
      }
    }
    if (generation === epoch) rememberClipboard(payload);
  } catch {
    /* Browser permission may be unavailable; copies within this session still work. */
  }
}
export async function pasteClipboardEntry(payload: ClipboardPayload) {
  const data = new DataTransfer();
  data.setData('text/plain', payload.text);
  data.setData('text/html', payload.html);
  if (payload.image) {
    const blob = await (await fetch(payload.image)).blob();
    data.items.add(new File([blob], 'clipboard.png', { type: blob.type }));
  }
  // Use the existing PDF paste path so editable objects, IDs and undo stay consistent.
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
}
