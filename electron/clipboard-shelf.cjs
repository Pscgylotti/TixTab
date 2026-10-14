const { createHash, randomUUID } = require('node:crypto');
const NORMAL_BYTES = 128 * 1024 * 1024;
const LOW_BYTES = 32 * 1024 * 1024;
const PAGE_SIZE = 40;

// Session-only ownership: retain compressed PNG bytes, never decoded bitmaps or PDFs.
function createClipboardShelf({ clipboard, nativeImage, sequence, changed = () => {} }) {
  const byKey = new Map(),
    byId = new Map();
  let newest,
    oldest,
    bytes = 0,
    limit = NORMAL_BYTES,
    lastSequence,
    pending,
    disposed = false,
    paused = false,
    epoch = 0;
  function list(offset = 0) {
    offset = Number.isInteger(offset)
      ? Math.max(0, Math.min(offset, Math.max(0, Math.ceil(byId.size / PAGE_SIZE) - 1) * PAGE_SIZE))
      : 0;
    const entries = [];
    let item = newest,
      at = 0;
    while (item && entries.length < PAGE_SIZE) {
      if (at++ >= offset) entries.push(item.summary);
      item = item.next;
    }
    return { entries, bytes, limit, total: byId.size, offset, paused };
  }
  function unlink(entry) {
    if (entry.previous) entry.previous.next = entry.next;
    else newest = entry.next;
    if (entry.next) entry.next.previous = entry.previous;
    else oldest = entry.previous;
    entry.previous = entry.next = undefined;
  }
  function prepend(entry) {
    entry.next = newest;
    if (newest) newest.previous = entry;
    else oldest = entry;
    newest = entry;
  }
  function drop(entry) {
    unlink(entry);
    bytes -= entry.cost;
    byKey.delete(entry.key);
    byId.delete(entry.summary.id);
  }
  function trim() {
    while (oldest && bytes > limit) drop(oldest);
  }
  function capture() {
    if (disposed || paused) return Promise.resolve();
    if (pending) return pending;
    const generation = epoch;
    pending = (async () => {
      const serial = sequence?.();
      if (serial !== undefined && serial === lastSequence) return;
      const items = await clipboard.read();
      let text = '',
        html = '',
        image;
      for (const item of items.slice(0, 1)) {
        for (const type of ['text/plain', 'text/html', 'image/png']) {
          if (!item.types.includes(type)) continue;
          const blob = await item.getType(type);
          if (blob.size > limit) continue;
          if (type === 'text/plain') text = await blob.text();
          if (type === 'text/html') html = await blob.text();
          if (type === 'image/png') image = Buffer.from(await blob.arrayBuffer());
        }
      }
      if (disposed || paused || generation !== epoch) return;
      // A clipboard read may span a change. Retry next tick rather than keep mismatched formats.
      if (serial !== undefined && sequence?.() !== serial) return;
      lastSequence = serial;
      if (/^TixTab page [0-9a-f-]{36}$/i.test(text)) return;
      const custom = html.match(/\bdata-tixtab-(objects|ink)\s*=/i);
      const kind = custom ? custom[1].toLowerCase() : image ? 'image' : 'text';
      // Ordinary HTML is not needed for PDF text insertion; do not retain hidden HTML payloads.
      if (!custom) html = '';
      if (kind !== 'image') image = undefined;
      if (!text.trim() && !html && !image) return;
      const size = (text.length + html.length) * 2 + (image?.length ?? 0);
      if (size + 2048 > limit) return;
      if (image && !pngSize(image)) return;
      const key = createHash('sha256')
        .update(text)
        .update(html)
        .update(image || '')
        .digest('hex');
      const prior = byKey.get(key);
      if (prior && prior === newest) return;
      if (prior) {
        unlink(prior);
        prepend(prior);
        changed();
        return;
      }
      const summary = { id: randomUUID(), kind, text: text.slice(0, 600), preview: '', count: 1 };
      if (image) {
        Object.assign(summary, pngSize(image));
        if (summary.width * summary.height <= 4_000_000) summary.preview = thumbnail(image);
      }
      // Large editable payloads remain intact; do not synchronously parse them for a preview.
      if (custom && html.length <= 4 * 1024 * 1024) {
        try {
          const attribute = html.match(/\bdata-tixtab-(?:objects|ink)\s*=\s*("[^"]*"|'[^']*')/i);
          const raw = attribute[1]
            .slice(1, -1)
            .replace(
              /&(quot|apos|lt|gt|amp|#39);/g,
              (_, name) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', '#39': "'" })[name],
            );
          const value = JSON.parse(raw);
          const objects = kind === 'objects' ? value.objects : value.strokes;
          if (Array.isArray(objects)) {
            summary.count = objects.length;
            if (kind === 'objects') {
              const first = objects[0],
                source = first?.displayData || first?.data;
              if (typeof source === 'string' && source.startsWith('data:image/')) {
                if (/^data:image\/svg\+xml/.test(source) && source.length < 128_000)
                  summary.preview = source;
                else if (/^data:image\/png;base64,/i.test(source)) {
                  const buffer = Buffer.from(source.split(',')[1], 'base64'),
                    size = pngSize(buffer);
                  if (size && size.width * size.height <= 4_000_000)
                    summary.preview = thumbnail(buffer);
                }
              }
            } else summary.preview = inkPreview(objects);
          }
        } catch {
          /* Malformed custom data is validated again by the normal paste handler. */
        }
      }
      const cost = size + (summary.preview.length + summary.text.length) * 2 + 768;
      if (cost > limit) return;
      const entry = { key, text, html, image, summary, cost };
      prepend(entry);
      byKey.set(key, entry);
      byId.set(summary.id, entry);
      bytes += cost;
      trim();
      changed();
    })()
      .catch(() => {
        /* Clipboard may be temporarily locked by another app; retry later. */
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  function thumbnail(buffer) {
    try {
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) return '';
      const { width, height } = image.getSize(),
        scale = Math.min(1, 160 / width, 96 / height);
      return image
        .resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        })
        .toDataURL();
    } catch {
      return '';
    }
  }
  function remove(id) {
    const entry = byId.get(id);
    if (!entry) return;
    drop(entry);
    changed();
  }
  // No repeated full reads on platforms without a cheap change sequence.
  const timer = sequence ? setInterval(() => void capture(), 750) : null;
  timer?.unref?.();
  void capture();
  return {
    capture,
    list,
    get(id) {
      const entry = byId.get(id);
      return entry
        ? {
            text: entry.text,
            html: entry.html,
            image: entry.image ? `data:image/png;base64,${entry.image.toString('base64')}` : '',
          }
        : null;
    },
    remove,
    clear() {
      epoch++;
      byKey.clear();
      byId.clear();
      newest = oldest = undefined;
      bytes = 0;
      lastSequence = sequence?.();
      changed();
    },
    pause(value) {
      if (typeof value !== 'boolean') return;
      epoch++;
      paused = value;
      changed();
    },
    memory(low) {
      if (typeof low !== 'boolean') return;
      epoch++;
      limit = low ? LOW_BYTES : NORMAL_BYTES;
      trim();
      changed();
    },
    dispose() {
      disposed = true;
      epoch++;
      clearInterval(timer);
      byKey.clear();
      byId.clear();
      newest = oldest = undefined;
      bytes = 0;
    },
  };
}
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    return null;
  const width = buffer.readUInt32BE(16),
    height = buffer.readUInt32BE(20);
  return width && height ? { width, height } : null;
}
function inkPreview(strokes) {
  const lines = strokes
    .slice(0, 80)
    .map((s) => ({
      color: /^#[a-f0-9]{3,8}$/i.test(s?.color) ? s.color : '#477dd5',
      size: Number.isFinite(s?.size) ? Math.max(0.5, Math.min(100, s.size)) : 2,
      points: Array.isArray(s?.points)
        ? s.points
            .filter(
              (p) =>
                Array.isArray(p) &&
                Number.isFinite(p[0]) &&
                Number.isFinite(p[1]) &&
                Math.abs(p[0]) < 100000 &&
                Math.abs(p[1]) < 100000,
            )
            .filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 64)) === 0)
        : [],
    }))
    .filter((s) => s.points.length);
  if (!lines.length) return '';
  const points = lines.flatMap((s) => s.points),
    xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x = Math.min(...xs) - 4,
    y = Math.min(...ys) - 4,
    w = Math.max(...xs) - x + 4,
    h = Math.max(...ys) - y + 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}">${lines.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round" points="${s.points.map((p) => `${p[0]},${p[1]}`).join(' ')}"/>`).join('')}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
function clipboardSequence() {
  if (process.platform !== 'win32') return undefined;
  try {
    return require('koffi')
      .load('user32.dll')
      .func('uint32 __stdcall GetClipboardSequenceNumber()');
  } catch {
    return undefined;
  }
}
function attachClipboardNotifications(win, capture, api) {
  if (process.platform !== 'win32' && !api) return () => {};
  try {
    const library = api || require('koffi').load('user32.dll');
    const add = library.func('int __stdcall AddClipboardFormatListener(uintptr_t hwnd)');
    const remove = library.func('int __stdcall RemoveClipboardFormatListener(uintptr_t hwnd)');
    const buffer = win.getNativeWindowHandle();
    const hwnd = buffer.length === 8 ? buffer.readBigUInt64LE() : buffer.readUInt32LE();
    if (!add(hwnd)) return () => {};
    win.hookWindowMessage(0x031d, () => void capture());
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      try {
        remove(hwnd);
      } catch {}
      if (!win.isDestroyed()) win.unhookWindowMessage(0x031d);
    };
    win.once('closed', dispose);
    return dispose;
  } catch {
    return () => {};
  }
}
module.exports = {
  createClipboardShelf,
  clipboardSequence,
  attachClipboardNotifications,
  pngSize,
  inkPreview,
};
