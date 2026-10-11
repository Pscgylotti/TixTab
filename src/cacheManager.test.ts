import { test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import catalog from '../electron/cache-catalog.json';
const { createCacheManager } = createRequire(import.meta.url)('../electron/cache-manager.cjs');
const token = 'a'.repeat(64);
const rows = () => catalog.items.map((item) => ({ id: item.id, bytes: 16, files: 1, token }));
const health = () =>
  new Response(JSON.stringify({ engine: 'Texo OpenVINO', capabilities: ['cache-lease-v1'] }));
const released = () =>
  new Response(JSON.stringify({ engine: 'SurfaceTab model lifecycle', loaded: false, ok: true }));

test('listing is lazy metadata only; validates complete and unique categories', async () => {
  const fetch = vi.fn(),
    runner = vi.fn(async () => ({ ok: true, rows: rows() })),
    manager = createCacheManager({ fetch, runner });
  expect(await manager.list(1)).toMatchObject({ ok: true });
  expect(fetch).not.toHaveBeenCalled();
  runner.mockResolvedValueOnce({ ok: true, rows: Array(5).fill(rows()[0]) });
  expect(await manager.list(1)).toEqual({ ok: false, error: 'failed' });
  runner.mockResolvedValueOnce({ ok: true, rows: rows().map((row) => ({ ...row, bytes: -1 })) });
  expect(await manager.list(1)).toEqual({ ok: false, error: 'failed' });
  runner.mockResolvedValueOnce({
    ok: true,
    rows: rows().map((row) => ({ ...row, error: 'unsafe' })),
  });
  expect(await manager.list(1)).toMatchObject({ ok: true });
});

test('invalid categories or snapshots never contact services or helper', async () => {
  const fetch = vi.fn(),
    runner = vi.fn(),
    manager = createCacheManager({ fetch, runner });
  for (const [id, value] of [
    ['../outside', token],
    ['extracted', 'bad'],
    ['extracted', 'A'.repeat(64)],
  ])
    expect(await manager.clear(1, id, value)).toEqual({ ok: false, error: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
});

test('native cleanup releases only idle compatible service and passes fixed catalog id', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(released()),
    runner = vi.fn(async () => ({ ok: true, filesDeleted: 1 }));
  expect(
    await createCacheManager({ fetch, runner }).clear(1, 'texo-compiled', token),
  ).toMatchObject({ ok: true });
  expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8766/health');
  expect(fetch.mock.calls[1][0]).toBe('http://127.0.0.1:8766/models/release');
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: 'release-idle' });
  expect(runner.mock.calls[0].slice(0, 3)).toEqual(['clear', 'texo-compiled', token]);
});

test('old, unidentified, busy or unavailable native services prevent helper mutation', async () => {
  for (const response of [
    new Response(JSON.stringify({ engine: 'Texo OpenVINO', capabilities: [] })),
    new Response('not json'),
    new Response(JSON.stringify({ engine: 'other', capabilities: ['cache-lease-v1'] })),
  ]) {
    const runner = vi.fn(),
      fetch = vi.fn(async () => response);
    expect(await createCacheManager({ fetch, runner }).clear(1, 'extracted', token)).toEqual({
      ok: false,
      error: 'legacy-service',
    });
    expect(runner).not.toHaveBeenCalled();
  }
  const runner = vi.fn(),
    fetch = vi
      .fn()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(new Response('{}', { status: 429 }));
  expect(await createCacheManager({ fetch, runner }).clear(1, 'extracted', token)).toEqual({
    ok: false,
    error: 'busy',
  });
  expect(runner).not.toHaveBeenCalled();
  const unavailable = createCacheManager({
    fetch: vi.fn(async () => {
      throw new Error('timeout');
    }),
    runner,
  });
  expect(await unavailable.clear(1, 'extracted', token)).toEqual({
    ok: false,
    error: 'unavailable',
  });
  expect(runner).not.toHaveBeenCalled();
});

test('no listener still requires helper lease; one active operation and owner cancellation', async () => {
  const fetch = vi.fn(async () => {
    throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
  });
  let entered = false;
  const runner = vi.fn(
    (_action: string, _id: string, _token: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        entered = true;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const manager = createCacheManager({ fetch, runner }),
    task = manager.clear(1, 'extracted', token);
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(await manager.list(2)).toEqual({ ok: false, error: 'busy' });
  expect(manager.cancel(2)).toBe(false);
  expect(manager.cancel(1)).toBe(true);
  expect(await task).toEqual({ ok: false, error: 'cancelled' });
  runner.mockImplementationOnce(async () => ({ ok: false, error: 'busy' }));
  expect(await manager.clear(1, 'extracted', token)).toEqual({ ok: false, error: 'busy' });
});
