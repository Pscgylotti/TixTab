import { getModelIdleSeconds } from './modelIdle';
import { RejectedProviderRequest } from './providerTasks';
import { noteNativeModel, releaseNativeModel } from './nativeResources';
import { connectNativeTexo, type NativeDevice } from './nativeTexo';
import { localSpeech, releaseTts } from './tts';
import { phonemizeSpeech, releasePhonemizer } from './phonemize';
import { t } from './i18n';
export class NativeSpeechRequestError extends RejectedProviderRequest {}
export function loadSpeechProvider() {
  try {
    const value = localStorage.getItem('surfacetab.speechProvider');
    if (['native', 'local', 'system'].includes(value ?? '')) return value!;
  } catch {
    /* Default remains usable. */
  }
  return 'native';
}
export function saveSpeechProvider(provider: string) {
  if (['native', 'local', 'system'].includes(provider))
    try {
      localStorage.setItem('surfacetab.speechProvider', provider);
    } catch {
      /* Session setting. */
    }
}
export function loadSpeechDevice(): NativeDevice {
  try {
    const value = localStorage.getItem('surfacetab.speechDevice');
    if (['AUTO', 'NPU', 'GPU', 'CPU'].includes(value ?? '')) return value as NativeDevice;
  } catch {
    /* Default remains usable. */
  }
  return 'AUTO';
}
export function saveSpeechDevice(device: NativeDevice) {
  try {
    localStorage.setItem('surfacetab.speechDevice', device);
  } catch {
    /* Session setting. */
  }
}
export async function powerSpeech(
  text: string,
  device: NativeDevice,
  progress: (text: string) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!text.trim() || text.length > 4000)
    throw new NativeSpeechRequestError(t('请将朗读选区缩短至 4000 字符以内'));
  try {
    progress(t('正在连接本地低功耗后端…'));
    const health = await connectNativeTexo(signal);
    signal.throwIfAborted();
    if (!health.capabilities?.includes('synthesize-experimental'))
      throw new Error('Native speech unavailable');
    releaseTts();
    progress(t('正在处理本地语音音素…'));
    const voice = /[\u4e00-\u9fff]/.test(text) ? 'zh_CN-huayan-x_low' : 'en_US-lessac-low';
    const chunks = await phonemizeSpeech(text, voice, signal);
    signal.throwIfAborted();
    progress(t('本地语音合成中；首次编译可能需要数秒…'));
    noteNativeModel(!!health.capabilities?.includes('release-idle'));
    const response = await fetch('http://127.0.0.1:8766/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice, chunks, device, idleReleaseSeconds: getModelIdleSeconds() }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    });
    if ([400, 422, 429, 499, 504].includes(response.status)) {
      const data = await response.json();
      throw new NativeSpeechRequestError(
        response.status === 429
          ? t('已有本地推理正在运行，请稍后重试')
          : typeof data.detail === 'string'
            ? data.detail
            : t('本地语音请求无效'),
        response.status,
      );
    }
    if (!response.ok || !(response.headers.get('Content-Type') ?? '').startsWith('audio/wav'))
      throw new Error('Native speech unavailable');
    const metadata = JSON.parse(response.headers.get('X-SurfaceTab-Speech') ?? 'null');
    if (
      metadata?.voice !== voice ||
      metadata.sampleRate !== 16000 ||
      !Number.isFinite(metadata.timing?.totalMs) ||
      !Array.isArray(metadata.vocoderDevices) ||
      !metadata.vocoderDevices.length ||
      !metadata.vocoderDevices.every((d: unknown) => ['CPU', 'NPU', 'GPU'].includes(String(d))) ||
      metadata.upstreamDevice !== 'CPU' ||
      metadata.tailDevice !== 'CPU'
    )
      throw new Error('Invalid native speech metadata');
    const audio = await response.blob();
    signal.throwIfAborted();
    if (audio.size < 44 || audio.size > 38400044) throw new Error('Invalid native audio size');
    return {
      audio,
      elapsed: metadata.timing.totalMs,
      device: metadata.vocoderDevices.join(' + '),
      fallback: !!metadata.fallback,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof NativeSpeechRequestError ||
      (error instanceof Error && error.name === 'TimeoutError')
    )
      throw error;
    releasePhonemizer();
    progress(t('本地加速不可用，已回退内置 CPU…'));
    await releaseNativeModel(signal);
    const result = await localSpeech(text, progress, signal);
    signal.throwIfAborted();
    return { ...result, device: 'CPU (WASM)', fallback: true };
  }
}
