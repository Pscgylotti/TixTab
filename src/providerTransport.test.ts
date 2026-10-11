import { it, expect, vi, afterEach } from 'vitest';
import {
  providerFetch,
  ProviderTransportInputError,
  type ProviderHttpRequest,
} from './providerTransport';
afterEach(() => vi.unstubAllGlobals());
const input = (signal = new AbortController().signal) => ({
  method: 'POST' as const,
  headers: new Headers({ 'Content-Type': 'application/json' }),
  body: '{"text":"fixture"}',
  signal,
});
it('adapts native pull streams to Response without reading ahead', async () => {
  const bridge = {
    start: vi.fn(async (_request: ProviderHttpRequest) => ({
      ok: true,
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: true,
    })),
    read: vi
      .fn()
      .mockResolvedValueOnce({ ok: true, done: false, bytes: new TextEncoder().encode('你好') })
      .mockResolvedValueOnce({ ok: true, done: true }),
    cancel: vi.fn(async () => ({ ok: true })),
  };
  vi.stubGlobal('window', { surfaceDesktop: { providerHttp: bridge } });
  vi.stubGlobal('fetch', vi.fn());
  const response = await providerFetch(new URL('https://api.test/v1'), input(), 'text', 15000);
  expect(bridge.read).not.toHaveBeenCalled();
  expect(await response.text()).toBe('你好');
  expect(bridge.read).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(bridge.start.mock.calls[0][0]).toMatchObject({
    kind: 'text',
    method: 'POST',
    body: '{"text":"fixture"}',
    timeoutMs: 15000,
  });
});
it('cancels a blocked start, preserves the user abort and never retries browser fetch', async () => {
  let resolve!: (v: unknown) => void;
  const bridge = {
    start: vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
    read: vi.fn(),
    cancel: vi.fn(async () => ({ ok: true })),
  };
  vi.stubGlobal('window', { surfaceDesktop: { providerHttp: bridge } });
  vi.stubGlobal('fetch', vi.fn());
  const abort = new AbortController(),
    pending = providerFetch(new URL('https://api.test'), input(abort.signal), 'text', 15000);
  abort.abort();
  expect(bridge.cancel).toHaveBeenCalled();
  resolve({ ok: false, error: 'aborted' });
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});
it('cancels abandoned bodies and classifies invalid/busy inputs without leaking IPC errors', async () => {
  const bridge = {
    start: vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: {}, body: true })
      .mockResolvedValueOnce({ ok: false, error: 'busy' })
      .mockResolvedValueOnce({ ok: false, error: 'input-limit' }),
    read: vi.fn(),
    cancel: vi.fn(async () => ({ ok: true })),
  };
  vi.stubGlobal('window', { surfaceDesktop: { providerHttp: bridge } });
  const response = await providerFetch(new URL('https://api.test'), input(), 'speech', 15000);
  await response.body!.cancel();
  expect(bridge.cancel).toHaveBeenCalled();
  expect(bridge.read).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++)
    await expect(
      providerFetch(new URL('https://api.test'), input(), 'text', 15000),
    ).rejects.toBeInstanceOf(ProviderTransportInputError);
  bridge.start.mockRejectedValueOnce(new Error('IPC url?key=private'));
  await expect(providerFetch(new URL('https://api.test'), input(), 'text', 15000)).rejects.toThrow(
    'Provider connection failed',
  );
});
