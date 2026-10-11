import { it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
const { createProviderRelay, validateRequest, CHUNK_BYTES } = createRequire(import.meta.url)(
  '../electron/provider-relay.cjs',
);
class Owner extends EventEmitter {
  constructor(public id: number) {
    super();
  }
  isDestroyed() {
    return false;
  }
}
const event = (owner = new Owner(1)) => ({ sender: owner });
const request = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  url: 'http://127.0.0.1:8765/ocr',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' },
  body: '{}',
  kind: 'text',
  timeoutMs: 15000,
  ...extra,
});
afterEach(() => vi.useRealTimers());
it('validates native boundaries independently of renderer types', () => {
  expect(validateRequest(request()).ok).toBe(true);
  for (const patch of [
    { url: 'file:///private' },
    { url: 'https://user:secret@example.com' },
    { method: 'GET' },
    { method: 'HEAD', body: 'selection' },
    { timeoutMs: 1 },
    { kind: 'anything' },
    { headers: { Cookie: 'secret' } },
    { headers: { 'Proxy-Authorization': 'private' } },
    { headers: { 'X-Api-Key': 'line\nbreak' } },
    { body: '中'.repeat(8_000_001) },
  ])
    expect(validateRequest(request(patch)).ok).toBe(false);
});
it('pulls bounded chunks on demand, preserving exact bytes without eager draining', async () => {
  let pulls = 0;
  const bytes = Uint8Array.from({ length: 150000 }, (_, i) => i % 251);
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        new ReadableStream(
          {
            pull(c) {
              pulls++;
              if (pulls === 1) c.enqueue(bytes);
              else c.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'Content-Type': 'application/octet-stream', 'Set-Cookie': 'private' } },
      ),
  );
  const relay = createProviderRelay({ fetch, allowedSender: () => true }),
    e = event(),
    r = request();
  try {
    const started = await relay.start(e, r);
    expect(started).toMatchObject({ ok: true, status: 200, body: true });
    expect(started.headers).not.toHaveProperty('set-cookie');
    expect(pulls).toBe(0);
    const result = [];
    while (true) {
      const next = await relay.read(e, r.id);
      expect(next.ok).toBe(true);
      if (next.done) break;
      expect(next.bytes.byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
      result.push(...next.bytes);
    }
    expect(new Uint8Array(result)).toEqual(bytes);
    expect(pulls).toBe(2);
    expect(relay.activeCount()).toBe(0);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } finally {
    relay.dispose();
  }
});
it('does not send HEAD bodies and releases an empty response immediately', async () => {
  const fetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 405 }),
    ),
    relay = createProviderRelay({ fetch, allowedSender: () => true });
  try {
    expect(await relay.start(event(), request({ method: 'HEAD', body: undefined }))).toMatchObject({
      ok: true,
      status: 405,
      body: false,
    });
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    expect(relay.activeCount()).toBe(0);
  } finally {
    relay.dispose();
  }
});
it('isolates owners, bounds concurrency and refuses duplicate IDs', async () => {
  const fetch = vi.fn(async () => new Response(new ReadableStream({}, { highWaterMark: 0 }))),
    relay = createProviderRelay({
      fetch,
      allowedSender: (e: { trusted?: boolean }) => e.trusted !== false,
    }),
    e = event(),
    other = event(new Owner(2)),
    r = request();
  try {
    expect((await relay.start({ ...e, trusted: false }, r)).error).toBe('untrusted');
    expect(fetch).not.toHaveBeenCalled();
    await relay.start(e, r);
    expect((await relay.start(e, r)).error).toBe('invalid');
    expect((await relay.read(other, r.id)).error).toBe('missing');
    await relay.cancel(other, r.id);
    expect(relay.activeCount()).toBe(1);
    for (let i = 0; i < 3; i++) await relay.start(e, request());
    expect((await relay.start(e, request())).error).toBe('busy');
    expect(relay.activeCount()).toBe(4);
    expect(e.sender.listenerCount('destroyed')).toBe(1);
  } finally {
    relay.dispose();
  }
  expect(e.sender.listenerCount('destroyed')).toBe(0);
});
it('bounds declared and streaming response sizes and sanitizes failures', async () => {
  const canceled = vi.fn(),
    fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: canceled }, { highWaterMark: 0 }), {
          headers: { 'Content-Length': '4000001' },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(4_000_001)))
      .mockRejectedValueOnce(new Error('https://api.test?key=secret'));
  const relay = createProviderRelay({ fetch, allowedSender: () => true }),
    e = event();
  try {
    expect(await relay.start(e, request())).toEqual({ ok: false, error: 'limit' });
    expect(canceled).toHaveBeenCalled();
    const r = request();
    await relay.start(e, r);
    expect(await relay.read(e, r.id)).toEqual({ ok: false, error: 'limit' });
    expect(await relay.start(e, request())).toEqual({ ok: false, error: 'network' });
    expect(relay.activeCount()).toBe(0);
  } finally {
    relay.dispose();
  }
});
it('cancels pending headers and active reads, and refuses concurrent reads', async () => {
  let networkSignal!: AbortSignal;
  const fetch = vi
    .fn()
    .mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
      networkSignal = init.signal;
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('private host'))),
      );
    })
    .mockResolvedValueOnce(new Response(new ReadableStream({}, { highWaterMark: 0 })));
  const relay = createProviderRelay({ fetch, allowedSender: () => true }),
    e = event(),
    r = request();
  try {
    const pending = relay.start(e, r);
    await Promise.resolve();
    await relay.cancel(e, r.id);
    expect(networkSignal.aborted).toBe(true);
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    const active = request();
    await relay.start(e, active);
    const read = relay.read(e, active.id);
    expect((await relay.read(e, active.id)).error).toBe('busy');
    await relay.cancel(e, active.id);
    expect(await read).toEqual({ ok: false, error: 'aborted' });
    expect(relay.activeCount()).toBe(0);
  } finally {
    relay.dispose();
  }
});
it('expires blocked connections without a renderer polling or reading', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('network'))),
      ),
  );
  const relay = createProviderRelay({ fetch, allowedSender: () => true });
  try {
    const pending = relay.start(event(), request({ timeoutMs: 2000 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ ok: false, error: 'timeout' });
    expect(relay.activeCount()).toBe(0);
  } finally {
    relay.dispose();
  }
});
it('stops connections on main navigation, renderer loss and destruction, retaining same-document navigation', async () => {
  const fetch = vi.fn(async () => new Response(new ReadableStream({}, { highWaterMark: 0 }))),
    relay = createProviderRelay({ fetch, allowedSender: () => true }),
    owner = new Owner(1),
    e = event(owner);
  try {
    await relay.start(e, request());
    owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(relay.activeCount()).toBe(1);
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(relay.activeCount()).toBe(0);
    await relay.start(e, request());
    owner.emit('render-process-gone');
    expect(relay.activeCount()).toBe(0);
    await relay.start(e, request());
    owner.emit('destroyed');
    expect(relay.activeCount()).toBe(0);
    expect(owner.listenerCount('destroyed')).toBe(0);
  } finally {
    relay.dispose();
  }
});
