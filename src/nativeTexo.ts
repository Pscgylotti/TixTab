import { getModelIdleSeconds } from './modelIdle';
import { RejectedProviderRequest } from './providerTasks';
import { noteNativeModel, releaseNativeModel } from './nativeResources';
import { recognizeTexo, releaseTexo } from './texo';
import { t } from './i18n';

export type NativeDevice = 'AUTO' | 'NPU' | 'GPU' | 'CPU';
type Health = {
  ok: boolean;
  devices: { id: string; name: string }[];
  loaded: boolean;
  encoderDevice: string | null;
  capabilities?: string[];
};
type Result = { latex: string; elapsed: number; device: string; fallback: boolean };
class NativeInputError extends RejectedProviderRequest {}
const endpoint = 'http://127.0.0.1:8766';
export function loadNativeDevice(): NativeDevice {
  try {
    const device = localStorage.getItem('surfacetab.texoDevice');
    if (['AUTO', 'NPU', 'GPU', 'CPU'].includes(device ?? '')) return device as NativeDevice;
  } catch {
    /* Default policy also works without storage. */
  }
  return 'AUTO';
}
export function saveNativeDevice(device: NativeDevice) {
  try {
    localStorage.setItem('surfacetab.texoDevice', device);
  } catch {
    /* Session setting remains usable. */
  }
}
export async function nativeTexoHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch(`${endpoint}/health`, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1200)]),
  });
  const data = await response.json();
  if (!response.ok || data.engine !== 'Texo OpenVINO' || !Array.isArray(data.devices))
    throw new Error('Native Texo unavailable');
  return data;
}
export async function connectNativeTexo(signal?: AbortSignal) {
  try {
    return await nativeTexoHealth(signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (!window.surfaceDesktop?.startNativeTexo) throw error;
    const started = await window.surfaceDesktop.startNativeTexo();
    signal?.throwIfAborted();
    if (!started.available) throw new Error(t('尚未安装本地加速运行时'));
    return nativeTexoHealth(signal);
  }
}
/** Power-first policy: NPU encoder → GPU encoder → CPU, with a two-thread CPU decoder.
 * If the optional runtime is absent or incompatible, keep the bundled WASM path usable. */
export async function recognizePowerTexo(
  image: string,
  device: NativeDevice,
  progress: (text: string) => void,
  signal: AbortSignal,
): Promise<Result> {
  signal.throwIfAborted();
  try {
    progress(t('正在连接本地低功耗后端…'));
    const health = await connectNativeTexo(signal);
    signal.throwIfAborted();
    // Do not retain a second browser model while native inference is in use.
    noteNativeModel(!!health.capabilities?.includes('release-idle'));
    releaseTexo();
    progress(t('本地加速识别中；首次编译可能需要数秒…'));
    const response = await fetch(`${endpoint}/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, device, idleReleaseSeconds: getModelIdleSeconds() }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    });
    const data = await response.json();
    if ([400, 422, 429, 499, 504].includes(response.status))
      throw new NativeInputError(
        typeof data.detail === 'string' && data.detail.includes('256 token')
          ? t('公式过长或无法辨认，请重写或选择更小区域')
          : typeof data.detail === 'string'
            ? data.detail
            : t('识别失败'),
        response.status,
      );
    if (
      !response.ok ||
      typeof data.latex !== 'string' ||
      !['NPU', 'GPU', 'CPU'].includes(data.encoderDevice) ||
      !Number.isFinite(data.timing?.totalMs)
    )
      throw new Error(data.detail || 'Native Texo failed');
    return {
      latex: data.latex,
      elapsed: data.timing.totalMs,
      device: `${data.encoderDevice} + CPU`,
      fallback: !!data.fallback,
    };
  } catch (error) {
    signal.throwIfAborted();
    // A busy native session should not spawn duplicate inference on another device.
    if (
      error instanceof NativeInputError ||
      (error instanceof Error &&
        (error.name === 'TimeoutError' || error.message.includes('already running')))
    )
      throw error;
    progress(t('本地加速不可用，已回退内置 CPU…'));
    await releaseNativeModel(signal);
    const result = await recognizeTexo(image, 'wasm', progress, signal);
    signal.throwIfAborted();
    return { ...result, device: 'CPU (WASM)', fallback: true };
  }
}
