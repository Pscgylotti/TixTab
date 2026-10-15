import { getModelIdleSeconds } from './modelIdle';
import { RejectedProviderRequest } from './providerTasks';
import { noteNativeModel, releaseNativeModel } from './nativeResources';
import { connectNativeTexo, type NativeDevice } from './nativeTexo';
import { localOcr, releaseOcr } from './ocr';
import { t } from './i18n';

class NativeOcrRequestError extends RejectedProviderRequest {}
export function loadOcrDevice(): NativeDevice {
  try {
    const value = localStorage.getItem('surfacetab.ocrDevice');
    if (['AUTO', 'NPU', 'GPU', 'CPU'].includes(value ?? '')) return value as NativeDevice;
  } catch {
    /* Session default. */
  }
  return 'AUTO';
}
export function saveOcrDevice(device: NativeDevice) {
  try {
    localStorage.setItem('surfacetab.ocrDevice', device);
  } catch {
    /* Session setting stays usable. */
  }
}
export function loadOcrProvider() {
  try {
    const value = localStorage.getItem('surfacetab.ocrLocalProvider');
    if (value === 'native' || value === 'local' || value === 'tesseract-native') return value;
  } catch {
    /* Session default. */
  }
  return 'native';
}
export function saveOcrProvider(provider: string) {
  if (provider === 'native' || provider === 'local' || provider === 'tesseract-native')
    try {
      localStorage.setItem('surfacetab.ocrLocalProvider', provider);
    } catch {
      /* No API credentials stored. */
    }
}

export async function recognizePowerOcr(
  image: string,
  device: NativeDevice,
  progress: (text: string) => void,
  signal: AbortSignal,
  layout = false,
) {
  signal.throwIfAborted();
  try {
    progress(t('正在连接本地低功耗后端…'));
    const health = await connectNativeTexo(signal);
    signal.throwIfAborted();
    if (!health.capabilities?.includes('ocr-experimental'))
      throw new Error('Native OCR requires the optional OCR runtime');
    releaseOcr();
    progress(t('本地加速识别中；首次编译可能需要数秒…'));
    noteNativeModel(!!health.capabilities?.includes('release-idle'));
    const response = await fetch('http://127.0.0.1:8766/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, device, idleReleaseSeconds: getModelIdleSeconds() }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    });
    const data = await response.json();
    if ([400, 422, 429, 499, 504].includes(response.status))
      throw new NativeOcrRequestError(
        response.status === 429
          ? t('已有本地推理正在运行，请稍后重试')
          : typeof data.detail === 'string'
            ? data.detail
            : t('本地 OCR 请求无效'),
        response.status,
      );
    const validDevices = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((d) => ['NPU', 'GPU', 'CPU'].includes(d));
    if (
      !response.ok ||
      typeof data.text !== 'string' ||
      !Number.isFinite(data.confidence) ||
      data.confidence < 0 ||
      data.confidence > 100 ||
      !Number.isFinite(data.timing?.totalMs) ||
      !validDevices(data.devices?.det) ||
      !validDevices(data.devices?.rec) ||
      data.projectionDevice !== 'CPU'
    )
      throw new Error('Native OCR unavailable');
    signal.throwIfAborted();
    const used = [...new Set([...data.devices.det, ...data.devices.rec, 'CPU'])];
    return {
      text: data.text,
      ...(layout && Array.isArray(data.lines) ? { lines: data.lines } : {}),
      confidence: data.confidence,
      elapsed: data.timing.totalMs,
      device: used.join(' + '),
      engine: 'PP-OCRv4',
      fallback: !!data.fallback,
    };
  } catch (error) {
    signal.throwIfAborted();
    // Do not duplicate native work after a rejected/busy/cancelled/timed-out request.
    if (
      error instanceof NativeOcrRequestError ||
      (error instanceof Error && error.name === 'TimeoutError')
    )
      throw error;
    progress(t('本地加速不可用，已回退内置 CPU…'));
    await releaseNativeModel(signal);
    const result = await localOcr(image, progress, signal, layout);
    signal.throwIfAborted();
    return { ...result, device: 'CPU (WASM)', engine: 'Tesseract', fallback: true };
  }
}
