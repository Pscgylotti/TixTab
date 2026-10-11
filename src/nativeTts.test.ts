import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./nativeTexo', () => ({ connectNativeTexo: vi.fn() }));
vi.mock('./tts', () => ({ localSpeech: vi.fn(), releaseTts: vi.fn() }));
vi.mock('./phonemize', () => ({ phonemizeSpeech: vi.fn(), releasePhonemizer: vi.fn() }));
import { connectNativeTexo } from './nativeTexo';
import { localSpeech, releaseTts } from './tts';
import { phonemizeSpeech } from './phonemize';
import { powerSpeech } from './nativeTts';
const fetchMock = vi.fn();
describe('native speech routing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.clearAllMocks();
    vi.mocked(connectNativeTexo).mockResolvedValue({
      ok: true,
      devices: [],
      loaded: false,
      encoderDevice: null,
      capabilities: ['synthesize-experimental'],
    });
    vi.mocked(phonemizeSpeech).mockResolvedValue([[1, 0, 20, 0, 2]]);
    vi.mocked(localSpeech).mockResolvedValue({
      audio: new Blob([new Uint8Array(48)]),
      elapsed: 20,
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('sends local phonemes and consumes binary audio with actual device metadata', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(48), {
        headers: {
          'Content-Type': 'audio/wav',
          'X-SurfaceTab-Speech': JSON.stringify({
            voice: 'en_US-lessac-low',
            sampleRate: 16000,
            vocoderDevices: ['CPU', 'NPU'],
            upstreamDevice: 'CPU',
            tailDevice: 'CPU',
            timing: { totalMs: 120 },
          }),
        },
      }),
    );
    const result = await powerSpeech('Hello', 'AUTO', vi.fn(), new AbortController().signal);
    expect(result.device).toBe('CPU + NPU');
    expect(result.audio.size).toBe(48);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      voice: 'en_US-lessac-low',
      chunks: [[1, 0, 20, 0, 2]],
      device: 'AUTO',
      idleReleaseSeconds: 1800,
    });
    expect(releaseTts).toHaveBeenCalledOnce();
    expect(localSpeech).not.toHaveBeenCalled();
  });
  it('older service falls back without loading the phonemizer', async () => {
    vi.mocked(connectNativeTexo).mockResolvedValue({
      ok: true,
      devices: [],
      loaded: false,
      encoderDevice: null,
      capabilities: ['recognize'],
    });
    expect(await powerSpeech('text', 'AUTO', vi.fn(), new AbortController().signal)).toMatchObject({
      device: 'CPU (WASM)',
      fallback: true,
    });
    expect(phonemizeSpeech).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([400, 422, 429, 499, 504])(
    'rejected/busy/cancelled/timed-out request %s does not duplicate synthesis',
    async (status) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'rejected' }), { status }));
      await expect(
        powerSpeech('text', 'NPU', vi.fn(), new AbortController().signal),
      ).rejects.toThrow();
      expect(localSpeech).not.toHaveBeenCalled();
    },
  );
  it('backend unavailability uses real fallback contract', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'missing model' }), { status: 503 }),
    );
    expect(await powerSpeech('文本', 'GPU', vi.fn(), new AbortController().signal)).toMatchObject({
      device: 'CPU (WASM)',
      fallback: true,
    });
    expect(phonemizeSpeech).toHaveBeenCalledWith(
      '文本',
      'zh_CN-huayan-x_low',
      expect.any(AbortSignal),
    );
  });
  it('cancellation or invalid input starts nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(powerSpeech('text', 'AUTO', vi.fn(), controller.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    await expect(
      powerSpeech('x'.repeat(4001), 'AUTO', vi.fn(), new AbortController().signal),
    ).rejects.toThrow();
    expect(connectNativeTexo).not.toHaveBeenCalled();
    expect(localSpeech).not.toHaveBeenCalled();
  });
});
