import type { ProviderConfig, ProviderFeature } from './providerSettings';
import type { NativeDevice } from './nativeTexo';
import { providerTasks, ProviderTaskError, type TaskContext, taskErrorCode } from './providerTasks';
import { t } from './i18n';
import { releaseNativeModel } from './nativeResources';
import { isLocalTranslationNoop, normalizeTranslationText } from './translationText';
import { withModelCacheUse, withCacheMaintenance } from './cacheAccess';

export interface ProviderCapability {
  id: string;
  feature: ProviderFeature;
  input: 'text' | 'image';
  output: 'text' | 'audio' | 'system';
  resource: 'local' | 'remote' | 'system';
  stream: boolean;
  cancel: boolean;
  models: string[];
}
const types: Record<ProviderFeature, string[]> = {
  translation: ['local', 'local-native', 'local-service', 'google', 'web', 'llm'],
  formula: ['texo-native', 'texo-cpu', 'texo-gpu', 'unimumer', 'pix2text', 'web', 'llm'],
  ocr: ['native', 'local', 'windows-ai', 'tesseract-native', 'texo', 'web', 'llm'],
  speech: ['native', 'local', 'system', 'web', 'llm'],
};
export function providerCapabilities(): ProviderCapability[] {
  return (Object.entries(types) as [ProviderFeature, string[]][]).flatMap(([feature, ids]) =>
    ids.map((id) => ({
      id,
      feature,
      input: feature === 'formula' || feature === 'ocr' ? 'image' : 'text',
      output: feature === 'speech' ? (id === 'system' ? 'system' : 'audio') : 'text',
      resource:
        id === 'system'
          ? 'system'
          : ['web', 'llm', 'google', 'local-service', 'pix2text'].includes(id)
            ? 'remote'
            : 'local',
      stream: id === 'llm' && feature !== 'speech',
      cancel: true,
      models: [
        'web',
        'llm',
        'google',
        'local-service',
        'pix2text',
        'system',
        'windows-ai',
      ].includes(id)
        ? []
        : feature === 'translation'
          ? ['opus-en-zh', 'opus-zh-en']
          : id === 'unimumer'
            ? ['unimumer-qwen3-vl-2b', 'unimumer-runtime']
            : feature === 'formula' || id === 'texo'
              ? ['texo']
              : feature === 'ocr'
                ? id === 'native'
                  ? ['ppocrv4']
                  : ['tesseract']
                : ['piper-en', 'piper-zh', 'piper-runtime'],
    })),
  );
}
export interface ProviderRequest {
  feature: ProviderFeature;
  config: ProviderConfig;
  input?: string;
  target?: string;
  device?: NativeDevice;
  localPreference?: string;
  operation?: 'run' | 'check';
  ocrLayout?: boolean;
}
export interface ProviderResult {
  lines?: import('./ocrLayout').OcrLine[];
  text?: string;
  audio?: Blob;
  systemVoice?: SpeechSynthesisVoice;
  httpStatus?: number;
  provider: string;
  modelId: string;
  device: string;
  engine: string;
  elapsed: number;
  confidence?: number;
  fallback: boolean;
  experimental: boolean;
}
const local = () => ({
  provider: '',
  modelId: '',
  device: '',
  engine: '',
  elapsed: 0,
  fallback: false,
  experimental: false,
});
let resident: { key: string; release: () => void } | undefined;
async function activate(key: string, release: () => void, native: boolean, signal: AbortSignal) {
  if (resident?.key !== key) {
    resident?.release();
    resident = { key, release };
  }
  if (!native) await releaseNativeModel(signal);
  signal.throwIfAborted();
}
export function releaseLocalResources(signal?: AbortSignal) {
  return providerTasks.withLocalLane(async () => {
    resident?.release();
    resident = undefined;
    return releaseNativeModel(signal, true);
  }, signal);
}
export function maintainLocalCaches<T>(work: () => Promise<T>, signal: AbortSignal) {
  return providerTasks.withLocalLane(
    () =>
      withCacheMaintenance(async () => {
        resident?.release();
        resident = undefined;
        signal.throwIfAborted();
        return work();
      }, signal),
    signal,
  );
}
function noFallback(error: unknown) {
  const code = taskErrorCode(error);
  return (
    ['cancelled', 'timeout', 'busy', 'invalid-input'].includes(code) ||
    (error instanceof Error && 'noFallback' in error && error.noFallback === true)
  );
}
function modelName(value: string) {
  return /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value) && !value.includes('://') ? value : 'configured';
}
async function systemVoice(input: string, signal: AbortSignal) {
  const voices = await new Promise<SpeechSynthesisVoice[]>((resolve, reject) => {
    const ready = speechSynthesis.getVoices();
    if (ready.length) {
      resolve(ready);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener('voiceschanged', done);
      signal.removeEventListener('abort', abort);
    };
    const done = () => {
        cleanup();
        resolve(speechSynthesis.getVoices());
      },
      abort = () => {
        cleanup();
        reject(signal.reason);
      };
    timer = setTimeout(done, 1000);
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const lang = /[\u4e00-\u9fff]/.test(input) ? 'zh' : 'en',
    voice = voices.find((v) => v.localService && v.lang.startsWith(lang));
  if (!voice) throw new Error(t('未找到匹配的系统离线声音'));
  return voice;
}
async function attempt(
  request: ProviderRequest,
  type: string,
  ctx: TaskContext,
): Promise<ProviderResult> {
  const { feature, config, input = '', target = 'zh-CN', device = 'AUTO' } = request,
    capability = providerCapabilities().find((c) => c.feature === feature && c.id === type)!;
  if (!capability) throw new ProviderTaskError('invalid-input', t('后端类型无效'));
  const modelId =
    type === 'windows-ai'
      ? 'windows-ai-system-ocr'
      : capability.resource === 'remote'
        ? modelName(config.model)
        : feature === 'translation'
          ? target === 'en'
            ? 'opus-zh-en'
            : 'opus-en-zh'
          : type === 'unimumer'
            ? 'unimumer-qwen3-vl-2b'
            : feature === 'formula' || type === 'texo'
              ? 'texo'
              : feature === 'ocr'
                ? type === 'native'
                  ? 'ppocrv4'
                  : 'tesseract'
                : type === 'system'
                  ? 'system-offline'
                  : /[\u4e00-\u9fff]/.test(input)
                    ? 'piper-zh'
                    : 'piper-en';
  const work = async () => {
    const start = performance.now();
    ctx.signal.throwIfAborted();
    if (capability.resource === 'remote') {
      const remote = await import('./remoteProvider');
      if (request.operation === 'check') {
        const value = await remote.checkProviderConnection(config, feature, ctx.signal);
        return {
          ...local(),
          provider: type,
          modelId,
          device: 'remote',
          engine: 'HTTP API',
          elapsed: performance.now() - start,
          httpStatus: value.status,
        };
      }
      if (feature === 'speech') {
        const audio = await remote.remoteSpeech(config, input, ctx.signal);
        return {
          ...local(),
          audio,
          provider: type,
          modelId,
          device: 'remote',
          engine: type === 'llm' ? 'LLM API' : 'HTTP API',
          elapsed: performance.now() - start,
        };
      }
      const r = await remote.remoteText(config, feature, input, target, ctx.signal, ctx.partial);
      return { ...local(), ...r, provider: type, modelId };
    }
    if (type === 'system') {
      const voice = await systemVoice(input, ctx.signal);
      return {
        ...local(),
        systemVoice: voice,
        provider: type,
        modelId,
        device: 'system',
        engine: t('系统本地声音'),
        elapsed: performance.now() - start,
      };
    }
    if (feature === 'translation') {
      const normalized = normalizeTranslationText(input);
      if (
        normalized.length > 0 &&
        normalized.length <= 10000 &&
        isLocalTranslationNoop(normalized, target)
      )
        return {
          ...local(),
          text: normalized,
          provider: type,
          modelId: 'none',
          device: t('无需推理'),
          engine: 'OPUS',
        };
      const wasm = await import('./translate');
      await activate(
        `${type}:${modelId}`,
        wasm.releaseTranslation,
        type === 'local-native',
        ctx.signal,
      );
      if (type === 'local-native') {
        const native = await import('./nativeOpus');
        const r = await native.translatePowerOpus(input, target, device, ctx.progress, ctx.signal);
        const noop = r.elapsed === 0 && r.device === t('无需推理');
        return {
          ...local(),
          ...r,
          provider: r.experimental || noop ? 'local-native' : 'local',
          modelId: noop ? 'none' : modelId,
          engine: 'OPUS',
        };
      }
      const r = await wasm.localTranslate(input, target, ctx.progress, ctx.signal);
      return {
        ...local(),
        ...r,
        provider: type,
        modelId: r.elapsed === 0 ? 'none' : modelId,
        device: r.elapsed === 0 ? t('无需推理') : 'CPU (WASM)',
        engine: 'OPUS',
      };
    }
    if (type === 'unimumer') {
      const wasm = await import('./texo');
      await activate('unimumer', wasm.releaseTexo, true, ctx.signal);
      wasm.releaseTexo();
      const native = await import('./nativeUnimumer');
      const r = await native.recognizeUnimumer(input, device, ctx.progress, ctx.signal);
      return { ...local(), ...r, provider: type, modelId, engine: 'Uni-MuMER Qwen3-VL-2B Q4_K_M' };
    }
    if (feature === 'formula' || type === 'texo') {
      const wasm = await import('./texo');
      await activate(
        `${type}:texo`,
        wasm.releaseTexo,
        type === 'texo-native' || type === 'texo',
        ctx.signal,
      );
      if (type === 'texo-native' || type === 'texo') {
        const native = await import('./nativeTexo');
        const r = await native.recognizePowerTexo(input, device, ctx.progress, ctx.signal);
        return {
          ...local(),
          ...r,
          text: r.latex,
          provider: r.device === 'CPU (WASM)' ? 'texo-cpu' : type,
          modelId,
          engine: 'Texo',
        };
      }
      const r = await wasm.recognizeTexo(
        input,
        type === 'texo-gpu' ? 'webgpu' : 'wasm',
        ctx.progress,
        ctx.signal,
      );
      return {
        ...local(),
        ...r,
        text: r.latex,
        provider: type,
        modelId,
        device: r.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)',
        engine: 'Texo',
      };
    }
    if (feature === 'ocr') {
      if (type === 'windows-ai') {
        const { withWindowsAiOcr } = await import('./windowsAiOcr');
        const { releaseOcr } = await import('./ocrWorkerSession');
        await activate('ocr:windows-ai', releaseOcr, false, ctx.signal);
        releaseOcr();
        ctx.progress(t('正在准备 Windows AI OCR 系统模型…'));
        const result = await withWindowsAiOcr(ctx.signal, (recognize) => recognize(input, 0));
        return {
          ...local(),
          ...result,
          provider: type,
          modelId,
          device: 'NPU',
          engine: 'Windows AI OCR',
          elapsed: performance.now() - start,
        };
      }

      if (type === 'tesseract-native') {
        const { withNativeCppOcr, nativeCppVariant, nativeCppModels } =
          await import('./nativeCppOcr');
        const { requireLocalModels } = await import('./modelLibrary');
        const { releaseOcr } = await import('./ocrWorkerSession');
        const variant = nativeCppVariant(config.model);
        await requireLocalModels(nativeCppModels(variant));
        await activate('ocr:tesseract-native', releaseOcr, false, ctx.signal);
        releaseOcr();
        ctx.progress(t('正在加载原生 OCR 模型…'));
        const r = await withNativeCppOcr(variant, 1, ctx.signal, (recognize) =>
          recognize(input, 0),
        );
        return {
          ...local(),
          ...r,
          provider: type,
          modelId: variant,
          device: variant.startsWith('npu-') ? 'NPU' : 'CPU (native)',
          engine: r.engine,
          experimental: variant.startsWith('npu-'),
          elapsed: performance.now() - start,
        };
      }
      const wasm = await import('./ocr');
      await activate(`${type}:tesseract`, wasm.releaseOcr, type === 'native', ctx.signal);
      if (type === 'native') {
        const native = await import('./nativeOcr');
        const r = await native.recognizePowerOcr(
          input,
          device,
          ctx.progress,
          ctx.signal,
          request.ocrLayout,
        );
        return {
          ...local(),
          ...r,
          provider: r.engine === 'Tesseract' ? 'local' : type,
          modelId: r.engine === 'Tesseract' ? 'tesseract' : modelId,
        };
      }
      const r = await wasm.localOcr(input, ctx.progress, ctx.signal, request.ocrLayout);
      return {
        ...local(),
        ...r,
        provider: type,
        modelId,
        device: 'CPU (WASM)',
        engine: 'Tesseract',
      };
    }
    const wasm = await import('./tts'),
      phonemes = await import('./phonemize');
    await activate(
      `${type}:${modelId}`,
      () => {
        wasm.releaseTts();
        phonemes.releasePhonemizer();
      },
      type === 'native',
      ctx.signal,
    );
    if (type === 'native') {
      const native = await import('./nativeTts');
      const r = await native.powerSpeech(input, device, ctx.progress, ctx.signal);
      return {
        ...local(),
        ...r,
        provider: r.device === 'CPU (WASM)' ? 'local' : type,
        modelId,
        engine: 'Piper',
        experimental: r.device !== 'CPU (WASM)',
      };
    }
    const r = await wasm.localSpeech(input, ctx.progress, ctx.signal);
    return { ...local(), ...r, provider: type, modelId, device: 'CPU (WASM)', engine: 'Piper' };
  };
  return ctx.attempt(
    capability.resource,
    {
      provider: type,
      modelId,
      device:
        capability.resource === 'remote' ? 'remote' : type === 'system' ? 'system' : 'pending',
    },
    () => (capability.resource === 'local' ? withModelCacheUse(work, ctx.signal) : work()),
  );
}
export async function executeProvider(
  request: ProviderRequest,
  options: {
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    onPartial?: (text: string) => void;
  } = {},
): Promise<ProviderResult> {
  // Capture one configuration; later edits cannot change an in-flight destination.
  request = { ...request, config: { ...request.config } };
  const { feature, config } = request,
    type = config.type;
  if (!types[feature]?.includes(type))
    throw new ProviderTaskError('invalid-input', t('后端类型无效'));
  if (
    request.operation === 'check' &&
    !providerCapabilities().find(
      (c) => c.feature === feature && c.id === type && c.resource === 'remote',
    )
  )
    throw new ProviderTaskError('invalid-input', t('此后端不支持网络连接检查'));
  return providerTasks.run(
    feature,
    type,
    async (ctx) => {
      if (request.operation !== 'check' && !request.input?.trim())
        throw new ProviderTaskError('invalid-input', t('输入不能为空'));
      const remote =
        providerCapabilities().find((c) => c.feature === feature && c.id === type)?.resource ===
        'remote';
      const localType =
        feature === 'formula'
          ? 'texo-native'
          : feature === 'translation'
            ? request.localPreference === 'local-native'
              ? 'local-native'
              : 'local'
            : request.localPreference === 'tesseract-native'
              ? 'tesseract-native'
              : request.localPreference === 'local'
                ? 'local'
                : 'native';
      const offline =
        feature === 'translation' &&
        remote &&
        config.fallback &&
        type !== 'local-service' &&
        typeof navigator !== 'undefined' &&
        !navigator.onLine;
      const chain = offline ? [localType] : [type];
      if (request.operation !== 'check') {
        if (feature === 'formula' && type === 'texo-gpu') chain.push('texo-cpu');
        else if (type === 'unimumer' && config.fallback) chain.push('texo-native');
        else if (remote && config.fallback && !offline) chain.push(localType);
        if (feature === 'speech' && type !== 'system' && (!remote || config.fallback))
          chain.push('system');
      }
      let previous: unknown;
      for (let i = 0; i < chain.length; i++) {
        ctx.signal.throwIfAborted();
        if (i || offline)
          ctx.progress(t(offline ? '离线回退 · ' : '远程或加速不可用，已回退本地 · '));
        try {
          const r = await attempt(request, chain[i], ctx);
          r.fallback = r.fallback || i > 0 || offline;
          ctx.complete(
            { provider: r.provider, modelId: r.modelId, device: r.device },
            r.elapsed,
            r.fallback,
          );
          return r;
        } catch (error) {
          ctx.signal.throwIfAborted();
          previous = error;
          const { ProviderInputError } = await import('./remoteProvider');
          if (
            noFallback(error) ||
            error instanceof ProviderInputError ||
            request.operation === 'check'
          )
            throw error;
        }
      }
      throw previous;
    },
    { ...options, operation: request.operation },
  );
}
export function providerResultStatus(result: ProviderResult) {
  const prefix = result.fallback ? t('已回退 · ') : '',
    confidence = result.confidence === undefined ? '' : ` · ${Math.round(result.confidence)}%`,
    experimental = result.experimental ? t(' · 实验性，请核对结果') : '';
  return t(
    '{0}{1} · {2} · {3} 秒{4}{5}，请检查结果。',
    prefix,
    result.engine,
    result.device,
    (result.elapsed / 1000).toFixed(2),
    confidence,
    experimental,
  );
}
export function providerFailureStatus(error: unknown, remote = false) {
  const code = taskErrorCode(error);
  if (code === 'cancelled') return t('已取消');
  if (code === 'timeout') return t('任务超时');
  if (remote && code === 'unavailable')
    return error instanceof Error && /^HTTP \d{3}$/.test(error.message)
      ? error.message
      : t('接口无法连接或返回格式不正确');
  return error instanceof Error ? error.message : t('未知错误');
}

/** A bounded bitmap batch holds the local resource/cache lease once. Each
 * Tesseract lane owns its worker; other local AI cannot compete with the batch. */
export async function withBitmapOcrPool<T>(
  count: number,
  signal: AbortSignal,
  work: (
    recognize: (
      image: string,
      lane: number,
    ) => Promise<{ text: string; lines?: import('./ocrLayout').OcrLine[]; engine: string }>,
  ) => Promise<T>,
) {
  return providerTasks.withLocalLane(
    () =>
      withModelCacheUse(async () => {
        const { requireLocalModels } = await import('./modelLibrary');
        const { createOcrSession, releaseOcr } = await import('./ocrWorkerSession');
        const { createOcrPixelBudget, ocrInputPixels } = await import('./ocrPixelBudget');
        const acquirePixels = createOcrPixelBudget();
        await requireLocalModels(['tesseract']);
        signal.throwIfAborted();
        await activate('bitmap:tesseract', releaseOcr, false, signal);
        releaseOcr();
        const poolAbort = new AbortController();
        const poolSignal = AbortSignal.any([signal, poolAbort.signal]);
        const slots: {
          session: ReturnType<typeof createOcrSession>;
          busy: boolean;
          pixels: number;
        }[] = [];
        const activeJobs = new Set<Promise<import('./bitmapOcr').BitmapRecognition>>();
        const limit = Math.max(1, Math.min(4, Math.floor(count)));
        try {
          return await work((image) => {
            const run = async () => {
              const pixels = ocrInputPixels(image);
              const releasePixels = await acquirePixels(pixels, poolSignal);
              let slot: (typeof slots)[number] | undefined;
              try {
                poolSignal.throwIfAborted();
                // Reuse an idle owner, not a fixed decode lane. A long scan of
                // 4MP pages must not eventually grow four idle WASM heaps.
                slot = slots.find((s) => !s.busy);
                if (!slot) {
                  if (slots.length >= limit) throw new Error('OCR pool owner limit exceeded');
                  slot = { session: createOcrSession(false), busy: false, pixels: 0 };
                  slots.push(slot);
                }
                slot.busy = true;
                slot.pixels = Math.max(slot.pixels, pixels);
                return {
                  ...(await slot.session.localOcr(image, () => {}, poolSignal, true)),
                  engine: 'Tesseract',
                };
              } finally {
                if (slot) slot.busy = false;
                // WASM heaps do not shrink. Discard idle high-water owners
                // when the workload changes from large pages to small images.
                while (slots.reduce((n, s) => n + s.pixels, 0) > 4_000_000) {
                  const index = slots.findIndex((s) => !s.busy);
                  if (index < 0) break;
                  slots.splice(index, 1)[0].session.releaseOcr();
                }
                releasePixels();
              }
            };
            const job = run();
            activeJobs.add(job);
            void job.then(
              () => activeJobs.delete(job),
              () => activeJobs.delete(job),
            );
            return job;
          });
        } finally {
          poolAbort.abort();
          await Promise.allSettled([...activeJobs]);
          slots.forEach((slot) => slot.session.releaseOcr());
          slots.length = 0;
        }
      }, signal),
    signal,
  );
}

export async function withBitmapNativeCppOcr<T>(
  variant: import('./nativeCppOcr').NativeCppVariant,
  count: number,
  signal: AbortSignal,
  work: (
    recognize: (image: string, lane: number) => Promise<import('./bitmapOcr').BitmapRecognition>,
  ) => Promise<T>,
) {
  return providerTasks.withLocalLane(
    () =>
      withModelCacheUse(async () => {
        const { requireLocalModels } = await import('./modelLibrary');
        const { releaseOcr } = await import('./ocrWorkerSession');
        const { withNativeCppOcr, nativeCppModels } = await import('./nativeCppOcr');
        await requireLocalModels(nativeCppModels(variant));
        await activate('bitmap:tesseract-native', releaseOcr, false, signal);
        releaseOcr();
        return withNativeCppOcr(variant, count, signal, work);
      }, signal),
    signal,
  );
}
export async function withBitmapNpuOcr<T>(
  variant: import('./nativeTesseract').TesseractVariant,
  batch: number,
  signal: AbortSignal,
  work: (
    recognize: (image: string, lane: number) => Promise<import('./bitmapOcr').BitmapRecognition>,
  ) => Promise<T>,
) {
  return providerTasks.withLocalLane(
    () =>
      withModelCacheUse(async () => {
        const { requireLocalModels } = await import('./modelLibrary');
        const { releaseOcr } = await import('./ocrWorkerSession');
        const { withQueuedNpuTesseract } = await import('./nativeTesseract');
        await requireLocalModels([
          'tesseract',
          variant === 'mixed-best' ? 'tesseract-openvino-zh' : 'tesseract-openvino',
        ]);
        signal.throwIfAborted();
        await activate('bitmap:tesseract-npu', releaseOcr, true, signal);
        releaseOcr();
        return withQueuedNpuTesseract(variant, batch, signal, work);
      }, signal),
    signal,
  );
}

/** Keep one system recognizer for a batch, release it even on cancel/failure. */
export async function withBitmapWindowsAiOcr<T>(
  signal: AbortSignal,
  work: (
    recognize: (image: string, lane: number) => Promise<import('./bitmapOcr').BitmapRecognition>,
  ) => Promise<T>,
) {
  return providerTasks.withLocalLane(async () => {
    const { withWindowsAiOcr } = await import('./windowsAiOcr');
    const { releaseOcr } = await import('./ocrWorkerSession');
    await activate('bitmap:windows-ai', releaseOcr, false, signal);
    releaseOcr();
    return withWindowsAiOcr(signal, work);
  }, signal);
}
