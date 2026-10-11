import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./nativeTexo', () => ({ connectNativeTexo: vi.fn() }));
vi.mock('./translate', () => ({ localTranslate: vi.fn(), releaseTranslation: vi.fn() }));
import { connectNativeTexo } from './nativeTexo';
import { localTranslate } from './translate';
import { translatePowerOpus } from './nativeOpus';
const fetchMock = vi.fn();
describe('experimental OPUS native routing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.mocked(connectNativeTexo)
      .mockReset()
      .mockResolvedValue({
        ok: true,
        devices: [],
        loaded: false,
        encoderDevice: null,
        capabilities: ['translate-experimental'],
      });
    vi.mocked(localTranslate)
      .mockReset()
      .mockResolvedValue({ text: 'CPU translation', elapsed: 50 });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('joins PDF line wraps, preserves paragraphs and reports real devices', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          translation: '译文',
          encoderDevice: 'NPU',
          encoderDevices: ['NPU'],
          decoderDevice: 'CPU',
          timing: { totalMs: 34 },
          fallback: false,
        }),
      ),
    );
    const result = await translatePowerOpus(
      'The book\nis here.\n\nNext paragraph.',
      'zh-CN',
      'AUTO',
      vi.fn(),
      new AbortController().signal,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      text: 'The book is here.\n\nNext paragraph.',
      direction: 'en-zh',
      device: 'AUTO',
    });
    expect(result).toEqual({
      text: '译文',
      elapsed: 34,
      device: 'NPU + CPU',
      fallback: false,
      experimental: true,
    });
    expect(localTranslate).not.toHaveBeenCalled();
  });
  it('keeps older formula-only services usable through WASM without posting a translation', async () => {
    vi.mocked(connectNativeTexo).mockResolvedValue({
      ok: true,
      devices: [],
      loaded: false,
      encoderDevice: null,
    });
    expect(
      (await translatePowerOpus('The book', 'zh-CN', 'AUTO', vi.fn(), new AbortController().signal))
        .device,
    ).toBe('CPU (WASM)');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localTranslate).toHaveBeenCalledOnce();
  });
  it.each([400, 422, 429, 499, 504])(
    'does not duplicate rejected/busy/timed-out native inference (%s)',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ detail: 'request rejected' }), { status }),
      );
      await expect(
        translatePowerOpus('The book', 'zh-CN', 'AUTO', vi.fn(), new AbortController().signal),
      ).rejects.toThrow();
      expect(localTranslate).not.toHaveBeenCalled();
    },
  );
  it('falls back when the native driver fails', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'driver unavailable' }), { status: 503 }),
    );
    expect(
      await translatePowerOpus('The book', 'zh-CN', 'GPU', vi.fn(), new AbortController().signal),
    ).toMatchObject({ text: 'CPU translation', fallback: true, experimental: false });
  });
  it('does not infer after cancellation or when translation is unnecessary', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      translatePowerOpus('The book', 'zh-CN', 'AUTO', vi.fn(), controller.signal),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(
      (await translatePowerOpus('123.45', 'zh-CN', 'AUTO', vi.fn(), new AbortController().signal))
        .text,
    ).toBe('123.45');
    expect(connectNativeTexo).not.toHaveBeenCalled();
    expect(localTranslate).not.toHaveBeenCalled();
  });
});
