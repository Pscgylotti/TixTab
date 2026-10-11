const { open, realpath } = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const BASE = 'http://127.0.0.1:23119/api';
const KEY = /^[A-Z0-9]{8}$/;
const failure = (code) => Object.assign(new Error(code), { code });
function prefix(library) {
  if (
    library === 'users/0' ||
    (typeof library === 'string' && /^groups\/[1-9][0-9]{0,14}$/.test(library))
  )
    return '/' + library;
  throw failure('invalid');
}
function key(value) {
  if (typeof value !== 'string' || !KEY.test(value)) throw failure('invalid');
  return value;
}
function item(raw) {
  const d = raw?.data;
  if (!KEY.test(raw?.key) || !d || typeof d !== 'object') throw failure('response');
  return {
    key: raw.key,
    title: String(d.title || d.filename || '').slice(0, 2000),
    type: String(d.itemType || ''),
    author: (Array.isArray(d.creators) ? d.creators : [])
      .slice(0, 8)
      .map((c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' '))
      .join(', ')
      .slice(0, 2000),
    date: String(d.date || '').slice(0, 80),
    pdf:
      d.itemType === 'attachment' &&
      (d.contentType === 'application/pdf' || /\.pdf$/i.test(d.filename || '')),
    filename: path
      .basename(String(d.filename || 'attachment.pdf'))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 200),
    children: Number(raw.meta?.numChildren) || 0,
  };
}
async function limited(response, max) {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw failure('too-large');
  }
  if (!response.body) throw failure('response');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max) throw failure('too-large');
      chunks.push(Buffer.from(r.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}
function createZotero({ fetch = globalThis.fetch, shell, clipboard }) {
  const jobs = new Map();
  async function run(owner, request) {
    if (jobs.has(owner)) return { ok: false, error: 'busy' };
    const abort = new AbortController();
    jobs.set(owner, abort);
    const timer = setTimeout(() => abort.abort(), 30000);
    try {
      const r = request;
      if (!r || typeof r !== 'object') throw failure('invalid');
      const p = prefix(r.library || 'users/0');
      if (
        r.serverId !== undefined &&
        (typeof r.serverId !== 'string' || !/^[\w-]{0,100}$/.test(r.serverId))
      )
        throw failure('invalid');
      let serverId = '';
      async function get(route, params = {}) {
        const url = new URL(BASE + route);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
        const response = await fetch(url.href, {
          method: 'GET',
          redirect: 'manual',
          signal: abort.signal,
          credentials: 'omit',
          headers: {
            'Zotero-API-Version': '3',
            ...(r.serverId ? { 'Zotero-Server-ID': r.serverId } : {}),
          },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw failure(
            { 403: 'disabled', 404: 'missing', 412: 'changed', 501: 'unsupported' }[
              response.status
            ] || 'response',
          );
        }
        serverId = response.headers.get('zotero-server-id') || '';
        if (!/^[\w-]{0,100}$/.test(serverId)) {
          await response.body?.cancel();
          throw failure('response');
        }
        return response;
      }
      async function json(route, params) {
        const response = await get(route, params),
          text = await limited(response, 4 * 1024 * 1024);
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw failure('response');
        }
        return { data, total: Number(response.headers.get('total-results')) || 0 };
      }
      let result;
      if (r.action === 'libraries') {
        const { data } = await json('/users/0/groups', { limit: 100 });
        if (!Array.isArray(data)) throw failure('response');
        result = [
          { id: 'users/0', name: '' },
          ...data
            .filter((g) => /^[1-9][0-9]{0,14}$/.test(String(g.id)))
            .map((g) => ({
              id: `groups/${g.id}`,
              name: String(g.data?.name || g.name || g.id).slice(0, 200),
            })),
        ];
      } else if (['items', 'collections', 'children'].includes(r.action)) {
        const start = r.start ?? 0,
          limit = r.action === 'items' ? 50 : 100;
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          start > 1000000 ||
          (r.query !== undefined && (typeof r.query !== 'string' || r.query.length > 300))
        )
          throw failure('invalid');
        const route =
          r.action === 'collections'
            ? `${p}/collections`
            : r.action === 'children'
              ? `${p}/items/${key(r.key)}/children`
              : r.collection
                ? `${p}/collections/${key(r.collection)}/items/top`
                : `${p}/items/top`;
        const { data, total } = await json(route, {
          format: 'json',
          limit,
          start,
          ...(r.action === 'items'
            ? { sort: 'dateModified', direction: 'desc', ...(r.query ? { q: r.query } : {}) }
            : {}),
        });
        if (!Array.isArray(data) || data.length > limit) throw failure('response');
        result = {
          rows:
            r.action === 'collections'
              ? data.map((c) => ({
                  key: key(c.key),
                  name: String(c.data?.name || '').slice(0, 300),
                  parent: c.data?.parentCollection || null,
                }))
              : data.map(item),
          more: total ? start + data.length < total : data.length === limit,
        };
      } else if (r.action === 'bibtex') {
        result = await limited(
          await get(`${p}/items/${key(r.key)}`, { format: 'bibtex' }),
          1024 * 1024,
        );
        abort.signal.throwIfAborted();
        clipboard.writeText(result);
      } else if (r.action === 'reveal') {
        const target = p === '/users/0' ? 'library' : p.slice(1);
        await shell.openExternal(`zotero://select/${target}/items/${key(r.key)}`);
        result = true;
      } else if (r.action === 'pdf') {
        const { data } = await json(`${p}/items/${key(r.key)}`, { format: 'json' });
        const attachment = item(data);
        if (!attachment.pdf) throw failure('not-pdf');
        // Zotero returns local file URLs here. Never accept a renderer-supplied path,
        // redirect to a remote host, or a UNC/network share.
        const location = (
          await limited(await get(`${p}/items/${key(r.key)}/file/view/url`), 16384)
        ).trim();
        let url;
        try {
          url = new URL(location);
        } catch {
          throw failure('missing');
        }
        if (url.protocol !== 'file:' || url.hostname || url.search || url.hash)
          throw failure('invalid');
        const file = fileURLToPath(url);
        if (/^(\\\\|\/\/)/.test(file) || path.extname(file).toLowerCase() !== '.pdf')
          throw failure('not-pdf');
        const resolved = await realpath(file);
        if (/^(\\\\|\/\/)/.test(resolved)) throw failure('invalid');
        const handle = await open(resolved, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw failure('not-pdf');
          if (info.size > 256 * 1024 * 1024) throw failure('too-large');
          const bytes = Buffer.alloc(info.size);
          let offset = 0;
          while (offset < bytes.length) {
            abort.signal.throwIfAborted();
            const chunk = await handle.read(
              bytes,
              offset,
              Math.min(1024 * 1024, bytes.length - offset),
              offset,
            );
            if (!chunk.bytesRead) throw failure('response');
            offset += chunk.bytesRead;
          }
          if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw failure('not-pdf');
          result = {
            bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            filename: /\.pdf$/i.test(attachment.filename) ? attachment.filename : 'attachment.pdf',
            source: {
              library: p.slice(1),
              key: r.key,
              parentKey: r.parentKey ? key(r.parentKey) : undefined,
              serverId,
              title: attachment.title,
            },
          };
        } finally {
          await handle.close();
        }
      } else throw failure('invalid');
      abort.signal.throwIfAborted();
      return { ok: true, data: result, serverId };
    } catch (e) {
      const known = [
        'invalid',
        'response',
        'disabled',
        'missing',
        'changed',
        'unsupported',
        'too-large',
        'not-pdf',
      ];
      return {
        ok: false,
        error: abort.signal.aborted
          ? 'cancelled'
          : known.includes(e.code)
            ? e.code
            : ['ENOENT', 'EACCES'].includes(e.code)
              ? 'missing'
              : 'offline',
      };
    } finally {
      clearTimeout(timer);
      if (jobs.get(owner) === abort) jobs.delete(owner);
    }
  }
  return {
    run,
    cancel(owner) {
      const job = jobs.get(owner);
      job?.abort();
      return !!job;
    },
    dispose() {
      for (const j of jobs.values()) j.abort();
    },
  };
}
module.exports = { createZotero };
