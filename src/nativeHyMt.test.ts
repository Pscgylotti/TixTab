import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ health: vi.fn(), models: vi.fn(), note: vi.fn() }));
vi.mock('./nativeTexo', () => ({ connectNativeTexo: mocks.health }));
vi.mock('./modelLibrary', () => ({ requireLocalModels: mocks.models }));
vi.mock('./nativeResources', () => ({ noteNativeModel: mocks.note }));
import { translateHyMt } from './nativeHyMt';
const fetcher = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  mocks.health.mockResolvedValue({ capabilities: ['hymt2-translation-v1', 'release-idle'] });
  mocks.models.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
it.each(['llama', 'openvino'] as const)(
  'routes the pinned model/runtime and preserves real device identity (%s)',
  async (backend) => {
    const device = backend === 'llama' ? 'GPU' : 'NPU';
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          translation: 'Translated',
          encoderDevice: device,
          decoderDevice: device,
          timing: { totalMs: 15 },
        }),
      ),
    );
    const result = await translateHyMt(
      'Source',
      'fr',
      device,
      vi.fn(),
      new AbortController().signal,
      backend,
    );
    expect(result.device).toBe(backend === 'llama' ? 'GPU (Vulkan)' : 'NPU (OpenVINO)');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      text: 'Source',
      target: 'fr',
      backend,
      device,
    });
    expect(mocks.models).toHaveBeenCalledWith([
      'hymt2-1-8b',
      backend === 'llama' ? 'unimumer-runtime' : 'hymt-openvino-runtime',
    ]);
  },
);
it.each([400, 429, 499, 504])('never duplicates rejected/cancelled work (%s)', async (status) => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ detail: 'rejected' }), { status }));
  await expect(
    translateHyMt('Source', 'en', 'CPU', vi.fn(), new AbortController().signal),
  ).rejects.toMatchObject({ noFallback: true });
});
it('rejects NPU on Vulkan and old services before sending content', async () => {
  await expect(
    translateHyMt('Source', 'en', 'NPU', vi.fn(), new AbortController().signal),
  ).rejects.toMatchObject({ noFallback: true });
  mocks.health.mockResolvedValue({ capabilities: [] });
  await expect(
    translateHyMt('Source', 'en', 'CPU', vi.fn(), new AbortController().signal),
  ).rejects.toThrow('重启');
  expect(fetcher).not.toHaveBeenCalled();
});
