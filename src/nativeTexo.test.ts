import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./texo', () => ({ recognizeTexo: vi.fn(), releaseTexo: vi.fn() }));
import { recognizeTexo } from './texo';
import { recognizePowerTexo } from './nativeTexo';
const fetchMock = vi.fn();
const health = () =>
  new Response(
    JSON.stringify({ engine: 'Texo OpenVINO', devices: [{ id: 'NPU', name: 'Intel AI Boost' }] }),
  );
describe('power-first Texo routing', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.mocked(recognizeTexo).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());
  it('sends AUTO to native and reports the real encoder + decoder devices', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          latex: 'x',
          encoderDevice: 'NPU',
          decoderDevice: 'CPU',
          timing: { totalMs: 24 },
          fallback: false,
        }),
      ),
    );
    const result = await recognizePowerTexo('image', 'AUTO', vi.fn(), new AbortController().signal);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      image: 'image',
      device: 'AUTO',
      idleReleaseSeconds: 1800,
    });
    expect(result).toEqual({ latex: 'x', device: 'NPU + CPU', elapsed: 24, fallback: false });
    expect(recognizeTexo).not.toHaveBeenCalled();
  });
  it('falls back to bundled CPU when the optional local runtime is absent', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(recognizeTexo).mockResolvedValue({ latex: 'x', elapsed: 100, device: 'wasm' });
    expect(
      (await recognizePowerTexo('image', 'AUTO', vi.fn(), new AbortController().signal)).fallback,
    ).toBe(true);
    expect(recognizeTexo).toHaveBeenCalledWith(
      'image',
      'wasm',
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });
  it('does not start CPU work after user cancellation', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      throw new TypeError('aborted');
    });
    await expect(
      recognizePowerTexo('image', 'AUTO', vi.fn(), controller.signal),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(recognizeTexo).not.toHaveBeenCalled();
  });
  it('does not duplicate inference when the local session is busy', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'A local formula request is already running' }), {
        status: 429,
      }),
    );
    await expect(
      recognizePowerTexo('image', 'AUTO', vi.fn(), new AbortController().signal),
    ).rejects.toThrow('already running');
    expect(recognizeTexo).not.toHaveBeenCalled();
  });
  it('does not rerun rejected or overlong input on CPU', async () => {
    fetchMock.mockResolvedValueOnce(health()).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Formula exceeded the 256 token limit' }), {
        status: 400,
      }),
    );
    await expect(
      recognizePowerTexo('image', 'AUTO', vi.fn(), new AbortController().signal),
    ).rejects.toThrow('公式过长');
    expect(recognizeTexo).not.toHaveBeenCalled();
  });
  it.each([422, 499, 504])(
    'does not rerun validation/cancellation/timeout responses (%s)',
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(health())
        .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'rejected' }), { status }));
      await expect(
        recognizePowerTexo('image', 'AUTO', vi.fn(), new AbortController().signal),
      ).rejects.toThrow('rejected');
      expect(recognizeTexo).not.toHaveBeenCalled();
    },
  );
  it('does not duplicate work after the HTTP deadline', async () => {
    fetchMock
      .mockResolvedValueOnce(health())
      .mockRejectedValueOnce(new DOMException('deadline', 'TimeoutError'));
    await expect(
      recognizePowerTexo('image', 'AUTO', vi.fn(), new AbortController().signal),
    ).rejects.toHaveProperty('name', 'TimeoutError');
    expect(recognizeTexo).not.toHaveBeenCalled();
  });
});
