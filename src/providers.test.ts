import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const resources = vi.hoisted(() => ({ noteNativeModel: vi.fn(), releaseNativeModel: vi.fn() }));
vi.mock('./nativeResources', () => resources);
const mocks = vi.hoisted(() => ({
  remoteText: vi.fn(),
  probe: vi.fn(),
  remoteSpeech: vi.fn(),
  translate: vi.fn(),
  releaseTranslation: vi.fn(),
  texo: vi.fn(),
  nativeTexo: vi.fn(),
  releaseTexo: vi.fn(),
  ocr: vi.fn(),
  nativeOcr: vi.fn(),
  releaseOcr: vi.fn(),
  speech: vi.fn(),
  nativeSpeech: vi.fn(),
  releaseTts: vi.fn(),
  releasePhonemizer: vi.fn(),
}));
vi.mock('./remoteProvider', () => ({
  remoteText: mocks.remoteText,
  checkProviderConnection: mocks.probe,
  remoteSpeech: mocks.remoteSpeech,
  ProviderInputError: class extends Error {
    readonly code = 'invalid-input';
  },
}));
vi.mock('./translate', () => ({
  localTranslate: mocks.translate,
  releaseTranslation: mocks.releaseTranslation,
}));
vi.mock('./texo', () => ({ recognizeTexo: mocks.texo, releaseTexo: mocks.releaseTexo }));
vi.mock('./nativeTexo', () => ({ recognizePowerTexo: mocks.nativeTexo }));
vi.mock('./ocr', () => ({ localOcr: mocks.ocr, releaseOcr: mocks.releaseOcr }));
vi.mock('./nativeOcr', () => ({ recognizePowerOcr: mocks.nativeOcr }));
vi.mock('./tts', () => ({ localSpeech: mocks.speech, releaseTts: mocks.releaseTts }));
vi.mock('./nativeTts', () => ({ powerSpeech: mocks.nativeSpeech }));
vi.mock('./phonemize', () => ({ releasePhonemizer: mocks.releasePhonemizer }));
import { executeProvider, providerCapabilities } from './providers';
import { providerTasks, RejectedProviderRequest } from './providerTasks';
import { defaultProfile, type ProviderConfig } from './providerSettings';
const config = (type: string): ProviderConfig => ({
  ...defaultProfile('formula', type),
  type,
  model: 'small',
  url: 'https://api.test/private?token=private-url',
  key: 'private-key',
  headers: '{"X-Key":"private-header"}',
});
beforeEach(() => {
  vi.clearAllMocks();
  for (const f of Object.values(mocks)) f.mockReset();
  resources.releaseNativeModel.mockReset().mockResolvedValue('released');
  providerTasks.clear();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('speechSynthesis', { getVoices: () => [{ localService: true, lang: 'en-US' }] });
});
afterEach(() => vi.unstubAllGlobals());
it('records actual native fallback identity without retaining any input or credentials', async () => {
  mocks.remoteText.mockRejectedValue(new TypeError('Failed to fetch'));
  mocks.nativeTexo.mockResolvedValue({
    latex: 'private-result',
    device: 'CPU (WASM)',
    elapsed: 50,
    fallback: true,
  });
  const result = await executeProvider({
    feature: 'formula',
    config: config('web'),
    input: 'private-input',
    device: 'NPU',
  });
  expect(result).toMatchObject({
    provider: 'texo-cpu',
    modelId: 'texo',
    device: 'CPU (WASM)',
    fallback: true,
  });
  expect(providerTasks.getSnapshot()[0]).toMatchObject({
    requested: 'web',
    provider: 'texo-cpu',
    modelId: 'texo',
    device: 'CPU (WASM)',
    attempt: 2,
    phase: 'completed',
    fallback: true,
  });
  const stored = JSON.stringify(providerTasks.getSnapshot());
  for (const secret of [
    'private-input',
    'private-result',
    'private-key',
    'private-header',
    'private-url',
  ])
    expect(stored).not.toContain(secret);
});
it.each([429, 400, 499, 504])(
  'does not replay rejected native speech (%s) through a system voice',
  async (status) => {
    mocks.nativeSpeech.mockRejectedValue(new RejectedProviderRequest('rejected', status));
    const getVoices = vi.fn(() => []);
    vi.stubGlobal('speechSynthesis', { getVoices });
    await expect(
      executeProvider({ feature: 'speech', config: config('native'), input: 'hello' }),
    ).rejects.toMatchObject({ noFallback: true });
    expect(mocks.speech).not.toHaveBeenCalled();
    expect(getVoices).not.toHaveBeenCalled();
  },
);
it('preserves a disabled remote fallback', async () => {
  mocks.remoteText.mockRejectedValue(new Error('unavailable'));
  await expect(
    executeProvider({
      feature: 'formula',
      config: { ...config('web'), fallback: false },
      input: 'image',
    }),
  ).rejects.toThrow('unavailable');
  expect(mocks.nativeTexo).not.toHaveBeenCalled();
});
it('falls back from WebGPU to CPU and forwards the same cancellation signal', async () => {
  mocks.texo
    .mockRejectedValueOnce(new Error('GPU unavailable'))
    .mockResolvedValueOnce({ latex: 'x', elapsed: 5, device: 'wasm' });
  const result = await executeProvider({
    feature: 'formula',
    config: config('texo-gpu'),
    input: 'image',
  });
  expect(mocks.texo.mock.calls.map((call) => call[1])).toEqual(['webgpu', 'wasm']);
  expect(mocks.texo.mock.calls[0][3]).toBe(mocks.texo.mock.calls[1][3]);
  expect(result).toMatchObject({ provider: 'texo-cpu', device: 'CPU (WASM)', fallback: true });
});
it('does not retry GPU cancellation or timeout on CPU', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    mocks.texo.mockReset().mockRejectedValue(new DOMException('stop', name));
    await expect(
      executeProvider({ feature: 'formula', config: config('texo-gpu'), input: 'image' }),
    ).rejects.toMatchObject({ name });
    expect(mocks.texo).toHaveBeenCalledOnce();
  }
});
it('probes without input and does not fall back or load a model', async () => {
  mocks.probe.mockResolvedValue({ status: 405 });
  const result = await executeProvider({
    feature: 'formula',
    config: config('web'),
    operation: 'check',
  });
  expect(result.httpStatus).toBe(405);
  expect(mocks.remoteText).not.toHaveBeenCalled();
  expect(mocks.nativeTexo).not.toHaveBeenCalled();
  mocks.probe.mockRejectedValue(new Error('down'));
  await expect(
    executeProvider({ feature: 'formula', config: config('web'), operation: 'check' }),
  ).rejects.toThrow('down');
  expect(mocks.nativeTexo).not.toHaveBeenCalled();
});
it('releases the previous WASM model when another local model takes the lane', async () => {
  mocks.translate.mockResolvedValue({ text: 'ok', elapsed: 5 });
  mocks.ocr.mockResolvedValue({ text: 'ok', confidence: 90, elapsed: 5 });
  await executeProvider({
    feature: 'translation',
    config: config('local'),
    input: 'hello',
    target: 'zh-CN',
  });
  mocks.releaseTranslation.mockClear();
  await executeProvider({ feature: 'ocr', config: config('local'), input: 'image' });
  expect(mocks.releaseTranslation).toHaveBeenCalledOnce();
});
it('skips online translation when explicitly offline and fallback is enabled', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  mocks.translate.mockResolvedValue({ text: '本地', elapsed: 5 });
  const result = await executeProvider({
    feature: 'translation',
    config: config('google'),
    input: 'hello',
    target: 'zh-CN',
  });
  expect(result).toMatchObject({ provider: 'local', fallback: true, modelId: 'opus-en-zh' });
  expect(mocks.remoteText).not.toHaveBeenCalled();
});
it('only attaches bundled model IDs to actual local providers', () => {
  for (const item of providerCapabilities())
    if (item.resource !== 'local') expect(item.models).toEqual([]);
  expect(
    providerCapabilities().find((c) => c.id === 'texo' && c.feature === 'ocr')?.models,
  ).toEqual(['texo']);
});

it.each(['local', 'local-native'])(
  'keeps resident models for no-op translation on %s',
  async (type) => {
    const result = await executeProvider({
      feature: 'translation',
      config: config(type),
      input: '中文',
      target: 'zh-CN',
    });
    expect(result).toMatchObject({ modelId: 'none', device: '无需推理', elapsed: 0 });
    expect(mocks.translate).not.toHaveBeenCalled();
    expect(resources.releaseNativeModel).not.toHaveBeenCalled();
    expect(mocks.releaseOcr).not.toHaveBeenCalled();
  },
);
