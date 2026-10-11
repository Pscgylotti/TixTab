// Pull-based HTTP bridge. No listening port, credential log, polling loop or
// eager response buffering; a renderer can have only one outstanding read/task.
const { Buffer } = require('node:buffer');
const MAX_BODY = 24_000_000,
  CHUNK_BYTES = 65_536;
const RESPONSE_LIMITS = { text: 4_000_000, speech: 38_400_044 };
const forbiddenHeader =
  /^(?:host|cookie2?|content-length|connection|origin|referer|transfer-encoding|te|trailer|upgrade|expect|accept-encoding|keep-alive|access-control-request-.*|proxy-.*|sec-.*)$/i;
const validId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
const failure = (error) => ({ ok: false, error });
function validateRequest(raw) {
  if (
    !raw ||
    !validId(raw.id) ||
    !['HEAD', 'POST'].includes(raw.method) ||
    !Object.hasOwn(RESPONSE_LIMITS, raw.kind) ||
    !Number.isFinite(raw.timeoutMs) ||
    raw.timeoutMs < 2000 ||
    raw.timeoutMs > 180000 ||
    typeof raw.url !== 'string' ||
    raw.url.length > 2048
  )
    return failure('invalid');
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return failure('invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return failure('invalid');
  if (raw.method === 'HEAD' ? raw.body !== undefined : typeof raw.body !== 'string')
    return failure('invalid');
  if (raw.body && (raw.body.length > MAX_BODY || Buffer.byteLength(raw.body) > MAX_BODY))
    return failure('input-limit');
  if (
    !raw.headers ||
    typeof raw.headers !== 'object' ||
    Array.isArray(raw.headers) ||
    Object.keys(raw.headers).length > 36
  )
    return failure('invalid');
  const headers = new Headers();
  let headerBytes = 0;
  for (const [name, value] of Object.entries(raw.headers)) {
    if (
      name.length > 256 ||
      typeof value !== 'string' ||
      value.length > 8192 ||
      forbiddenHeader.test(name) ||
      /[\r\n]/.test(value)
    )
      return failure('invalid');
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > 32768) return failure('invalid');
    try {
      headers.set(name, value);
    } catch {
      return failure('invalid');
    }
  }
  url.hash = '';
  return {
    ok: true,
    id: raw.id,
    url: url.href,
    method: raw.method,
    headers,
    body: raw.body,
    timeoutMs: raw.timeoutMs,
    maxBytes: RESPONSE_LIMITS[raw.kind],
  };
}
function createProviderRelay({ fetch, allowedSender }) {
  const tasks = new Map(),
    owners = new Map();
  let disposed = false;
  function trusted(event) {
    try {
      return !disposed && allowedSender(event) && !event.sender.isDestroyed();
    } catch {
      return false;
    }
  }
  const keyFor = (owner, id) => `${owner.id}:${id}`;
  function finish(task, error) {
    if (tasks.get(task.key) !== task) return;
    tasks.delete(task.key);
    clearTimeout(task.timer);
    task.error = error;
    if (error) task.abort.abort();
    void task.reader?.cancel().catch(() => {});
    task.pending = undefined;
  }
  const cancelOwner = (owner) => {
    for (const task of tasks.values()) if (task.owner === owner) finish(task, 'aborted');
  };
  function watch(owner) {
    if (owners.has(owner.id)) return;
    const navigation = (details, _url, isInPlace, isMainFrame) => {
      if ((details.isMainFrame ?? isMainFrame) && !(details.isSameDocument ?? isInPlace))
        cancelOwner(owner);
    };
    const gone = () => cancelOwner(owner);
    const destroyed = () => {
      cancelOwner(owner);
      unwatch(owner);
    };
    owners.set(owner.id, { owner, navigation, gone, destroyed });
    owner.on('did-start-navigation', navigation);
    owner.on('render-process-gone', gone);
    owner.on('destroyed', destroyed);
  }
  function unwatch(owner) {
    const state = owners.get(owner.id);
    if (!state) return;
    owner.removeListener('did-start-navigation', state.navigation);
    owner.removeListener('render-process-gone', state.gone);
    owner.removeListener('destroyed', state.destroyed);
    owners.delete(owner.id);
  }
  return {
    async start(event, raw) {
      if (!trusted(event)) return failure('untrusted');
      const request = validateRequest(raw);
      if (!request.ok) return request;
      const owner = event.sender,
        key = keyFor(owner, request.id);
      if (tasks.has(key)) return failure('invalid');
      if (tasks.size >= 8 || [...tasks.values()].filter((task) => task.owner === owner).length >= 4)
        return failure('busy');
      const task = {
        key,
        owner,
        abort: new AbortController(),
        maxBytes: request.maxBytes,
        size: 0,
        reading: false,
        error: undefined,
      };
      tasks.set(key, task);
      watch(owner);
      task.timer = setTimeout(() => finish(task, 'timeout'), request.timeoutMs);
      task.timer.unref?.();
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: task.abort.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          bypassCustomProtocolHandlers: true,
        });
        if (task.error) {
          void response.body?.cancel().catch(() => {});
          return failure(task.error);
        }
        // Never forward authorization to a redirect, or leak cookies/locations
        // in response metadata. Chromium handles proxy and certificate checks.
        if (response.status < 200 || (response.status >= 300 && response.status < 400)) {
          void response.body?.cancel().catch(() => {});
          finish(task, 'network');
          return failure('network');
        }
        const headers = {
          'content-type': (response.headers.get('content-type') ?? '').slice(0, 1024),
        };
        if (request.method === 'HEAD' || !response.body) {
          void response.body?.cancel().catch(() => {});
          finish(task);
          return { ok: true, status: response.status, headers, body: false };
        }
        task.reader = response.body.getReader();
        if (Number(response.headers.get('content-length')) > task.maxBytes) {
          finish(task, 'limit');
          return failure('limit');
        }
        return { ok: true, status: response.status, headers, body: true };
      } catch {
        const error = task.error ?? 'network';
        finish(task, error);
        return failure(error);
      }
    },
    async read(event, id) {
      if (!trusted(event) || !validId(id)) return failure('untrusted');
      const task = tasks.get(keyFor(event.sender, id));
      if (!task) return failure('missing');
      if (!task.reader || task.reading) return failure('busy');
      task.reading = true;
      try {
        if (!task.pending) {
          const result = await task.reader.read();
          if (task.error) return failure(task.error);
          if (result.done) {
            finish(task);
            return { ok: true, done: true };
          }
          task.size += result.value.byteLength;
          if (task.size > task.maxBytes) {
            finish(task, 'limit');
            return failure('limit');
          }
          task.pending = result.value;
          task.offset = 0;
        }
        const bytes = task.pending.slice(task.offset, task.offset + CHUNK_BYTES);
        task.offset += bytes.byteLength;
        if (task.offset >= task.pending.byteLength) task.pending = undefined;
        return { ok: true, done: false, bytes };
      } catch {
        const error = task.error ?? 'network';
        finish(task, error);
        return failure(error);
      } finally {
        task.reading = false;
      }
    },
    cancel(event, id) {
      if (!trusted(event) || !validId(id)) return failure('untrusted');
      const task = tasks.get(keyFor(event.sender, id));
      if (task) finish(task, 'aborted');
      return { ok: true };
    },
    dispose() {
      disposed = true;
      for (const task of tasks.values()) finish(task, 'aborted');
      for (const { owner } of owners.values()) unwatch(owner);
    },
    // Test-only introspection; never exposed through preload/IPC.
    activeCount: () => tasks.size,
  };
}
module.exports = { createProviderRelay, validateRequest, MAX_BODY, CHUNK_BYTES };
