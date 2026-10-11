import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ health: vi.fn(), models: vi.fn(), note: vi.fn() }));
vi.mock('./nativeTexo', () => ({ connectNativeTexo: mocks.health }));
vi.mock('./modelLibrary', () => ({ requireLocalModels: mocks.models }));
vi.mock('./nativeResources', () => ({ noteNativeModel: mocks.note }));
import { recognizeUnimumer } from './nativeUnimumer';
const fetcher = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  mocks.health.mockResolvedValue({ capabilities: ['unimumer-experimental', 'release-idle'] });
  mocks.models.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
it('requires both optional assets and reports GPU identity from the real response', async () => {
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({
        latex: 'x',
        encoderDevice: 'GPU',
        timing: { totalMs: 12 },
        fallback: false,
      }),
    ),
  );
  expect(
    await recognizeUnimumer('image', 'GPU', vi.fn(), new AbortController().signal),
  ).toMatchObject({ text: 'x', device: 'GPU (Vulkan)', elapsed: 12, experimental: true });
  expect(mocks.models).toHaveBeenCalledWith(['unimumer-qwen3-vl-2b', 'unimumer-runtime']);
});
it.each([400, 429, 499, 504])(
  'preserves a rejection without allowing duplicate fallback work (%s)',
  async (status) => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ detail: 'rejected' }), { status }));
    await expect(
      recognizeUnimumer('image', 'AUTO', vi.fn(), new AbortController().signal),
    ).rejects.toMatchObject({ noFallback: true });
  },
);
it('rejects an older service before sending the image', async () => {
  mocks.health.mockResolvedValue({ capabilities: ['recognize'] });
  await expect(
    recognizeUnimumer('private-image', 'AUTO', vi.fn(), new AbortController().signal),
  ).rejects.toThrow('重启');
  expect(fetcher).not.toHaveBeenCalled();
});
