import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./nativeTexo', () => ({ connectNativeTexo: vi.fn() }));
vi.mock('./ocr', () => ({ localOcr: vi.fn(), releaseOcr: vi.fn() }));
import { connectNativeTexo } from './nativeTexo';
import { localOcr, releaseOcr } from './ocr';
import { recognizePowerOcr } from './nativeOcr';
const fetchMock = vi.fn();
describe('power-first OCR routing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.clearAllMocks();
    vi.mocked(connectNativeTexo).mockResolvedValue({
      ok: true,
      devices: [],
      loaded: false,
      encoderDevice: null,
      capabilities: ['ocr-experimental'],
    });
    vi.mocked(localOcr).mockResolvedValue({ text: 'bundled result', elapsed: 20, confidence: 90 });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('reports both accelerator and CPU stages, without retaining the browser OCR worker', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'local result',
          confidence: 98,
          devices: { det: ['NPU'], rec: ['NPU'] },
          projectionDevice: 'CPU',
          timing: { totalMs: 70 },
          fallback: false,
        }),
      ),
    );
    expect(
      await recognizePowerOcr('png', 'NPU', vi.fn(), new AbortController().signal),
    ).toMatchObject({
      text: 'local result',
      device: 'NPU + CPU',
      engine: 'PP-OCRv4',
      fallback: false,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      image: 'png',
      device: 'NPU',
      idleReleaseSeconds: 1800,
    });
    expect(releaseOcr).toHaveBeenCalledOnce();
    expect(localOcr).not.toHaveBeenCalled();
  });
  it('falls back for older services without sending an unsupported request', async () => {
    vi.mocked(connectNativeTexo).mockResolvedValue({
      ok: true,
      devices: [],
      loaded: false,
      encoderDevice: null,
      capabilities: ['recognize'],
    });
    expect(
      await recognizePowerOcr('png', 'AUTO', vi.fn(), new AbortController().signal),
    ).toMatchObject({ engine: 'Tesseract', fallback: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([400, 422, 429, 499, 504])(
    'does not duplicate rejected/busy/cancelled/timed-out work (%s)',
    async (status) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'rejected' }), { status }));
      await expect(
        recognizePowerOcr('png', 'AUTO', vi.fn(), new AbortController().signal),
      ).rejects.toThrow();
      expect(localOcr).not.toHaveBeenCalled();
    },
  );
  it('falls back on a real backend-unavailable response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'driver unavailable' }), { status: 503 }),
    );
    expect(
      await recognizePowerOcr('png', 'GPU', vi.fn(), new AbortController().signal),
    ).toMatchObject({ text: 'bundled result', device: 'CPU (WASM)', fallback: true });
  });
  it('does not start or fall back after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      recognizePowerOcr('png', 'AUTO', vi.fn(), controller.signal),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(connectNativeTexo).not.toHaveBeenCalled();
    expect(localOcr).not.toHaveBeenCalled();
  });
});
