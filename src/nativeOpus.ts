import { RejectedProviderRequest } from './providerTasks';
import { noteNativeModel, releaseNativeModel } from './nativeResources';
import { connectNativeTexo, type NativeDevice } from './nativeTexo';
import { localTranslate, releaseTranslation } from './translate';
import { isLocalTranslationNoop, normalizeTranslationText } from './translationText';
import { t } from './i18n';

class NativeRequestError extends RejectedProviderRequest {}
export type LocalTranslationResult = {
  text: string;
  elapsed: number;
  device: string;
  fallback: boolean;
  experimental: boolean;
};
export function loadOpusDevice(): NativeDevice {
  try {
    const value = localStorage.getItem('surfacetab.opusDevice');
    if (['AUTO', 'NPU', 'GPU', 'CPU'].includes(value ?? '')) return value as NativeDevice;
  } catch {
    /* Session default. */
  }
  return 'AUTO';
}
export function saveOpusDevice(device: NativeDevice) {
  try {
    localStorage.setItem('surfacetab.opusDevice', device);
  } catch {
    /* Session setting remains usable. */
  }
}
export function nativeOpusEnabled() {
  try {
    return localStorage.getItem('surfacetab.opusExperimental') === 'true';
  } catch {
    return false;
  }
}
export function setNativeOpusEnabled(enabled: boolean) {
  try {
    localStorage.setItem('surfacetab.opusExperimental', String(enabled));
  } catch {
    /* Session setting remains usable. */
  }
}

/** Explicit experimental option. Existing local translation remains the default. */
export async function translatePowerOpus(
  text: string,
  target: string,
  device: NativeDevice,
  progress: (text: string) => void,
  signal: AbortSignal,
): Promise<LocalTranslationResult> {
  signal.throwIfAborted();
  text = normalizeTranslationText(text);
  if (!['zh-CN', 'en'].includes(target))
    throw new Error(t('本地模型目前仅支持英文→中文、中文→英文'));
  if (!text || text.length > 10000) throw new Error(t('请将本地翻译选区缩短至 10000 字符以内'));
  if (isLocalTranslationNoop(text, target))
    return { text, elapsed: 0, device: t('无需推理'), fallback: false, experimental: false };
  try {
    progress(t('正在连接本地低功耗后端…'));
    const health = await connectNativeTexo(signal);
    signal.throwIfAborted();
    if (!health.capabilities?.includes('translate-experimental'))
      throw new Error('Native translation requires an updated local service');
    releaseTranslation();
    noteNativeModel(!!health.capabilities?.includes('release-idle'));
    progress(t('本地加速翻译中；首次编译可能需要数秒…'));
    const response = await fetch('http://127.0.0.1:8766/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, direction: target === 'en' ? 'zh-en' : 'en-zh', device }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    });
    const data = await response.json();
    if ([400, 422, 429, 499, 504].includes(response.status))
      throw new NativeRequestError(
        response.status === 429
          ? t('已有本地推理正在运行，请稍后重试')
          : typeof data.detail === 'string'
            ? data.detail
            : t('本地翻译请求无效'),
        response.status,
      );
    if (
      !response.ok ||
      typeof data.translation !== 'string' ||
      !['NPU', 'GPU', 'CPU'].includes(data.encoderDevice) ||
      data.decoderDevice !== 'CPU' ||
      !Number.isFinite(data.timing?.totalMs)
    )
      throw new Error(data.detail || 'Native OPUS failed');
    signal.throwIfAborted();
    return {
      text: data.translation,
      elapsed: data.timing.totalMs,
      device: `${data.encoderDevices?.join(' / ') || data.encoderDevice} + CPU`,
      fallback: !!data.fallback,
      experimental: true,
    };
  } catch (error) {
    signal.throwIfAborted();
    // Busy, invalid input and timed-out native work must not duplicate CPU work.
    if (
      error instanceof NativeRequestError ||
      (error instanceof Error && error.name === 'TimeoutError')
    )
      throw error;
    progress(t('本地加速不可用，已回退内置 CPU…'));
    await releaseNativeModel(signal);
    const result = await localTranslate(text, target, progress, signal);
    signal.throwIfAborted();
    return { ...result, device: 'CPU (WASM)', fallback: true, experimental: false };
  }
}
