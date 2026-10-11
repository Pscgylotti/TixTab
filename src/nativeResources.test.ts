import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let resources: typeof import('./nativeResources');
const fetchMock = vi.fn();
const released = () =>
  new Response(
    JSON.stringify({
      ok: true,
      engine: 'SurfaceTab model lifecycle',
      loaded: false,
      released: true,
    }),
  );
beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resources = await import('./nativeResources');
});
afterEach(() => vi.unstubAllGlobals());
it('does not contact a never-used native service when switching browser models', async () => {
  expect(await resources.releaseNativeModel()).toBe('not-contacted');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('releases a known native resident once with no model input or credentials', async () => {
  resources.noteNativeModel();
  fetchMock.mockResolvedValue(released());
  expect(await resources.releaseNativeModel()).toBe('released');
  expect(await resources.releaseNativeModel()).toBe('not-contacted');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8766/models/release');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'release-idle' });
});
it('keeps browser inference from overlapping a busy native session', async () => {
  resources.noteNativeModel();
  fetchMock.mockResolvedValue(new Response('', { status: 429 }));
  await expect(resources.releaseNativeModel()).rejects.toMatchObject({ code: 'busy' });
  fetchMock.mockResolvedValue(released());
  expect(await resources.releaseNativeModel()).toBe('released');
});
it.each([404, 405])(
  'allows an older native service (%s) to keep its own idle policy',
  async (status) => {
    resources.noteNativeModel();
    fetchMock.mockResolvedValue(new Response('', { status }));
    expect(await resources.releaseNativeModel()).toBe('unsupported');
  },
);
it('returns unavailable for malformed or unreachable service without loading anything', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, loaded: true })));
  expect(await resources.releaseNativeModel(undefined, true)).toBe('unavailable');
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  expect(await resources.releaseNativeModel(undefined, true)).toBe('unavailable');
});
it('does not swallow caller cancellation or contact a service after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(resources.releaseNativeModel(controller.signal, true)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
