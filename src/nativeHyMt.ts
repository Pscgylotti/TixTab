import { connectNativeTexo, type NativeDevice } from './nativeTexo';
import { requireLocalModels } from './modelLibrary';
import { noteNativeModel } from './nativeResources';
import { getModelIdleSeconds } from './modelIdle';
import { RejectedProviderRequest } from './providerTasks';
import { normalizeTranslationText } from './translationText';
import { t } from './i18n';

export function loadHyMtDevice(openvino = false): NativeDevice {
  try {
    const value = localStorage.getItem(
      openvino ? 'surfacetab.hymtOpenVinoDevice' : 'surfacetab.hymtDevice',
    );
    if ((openvino ? ['AUTO', 'GPU', 'CPU', 'NPU'] : ['AUTO', 'GPU', 'CPU']).includes(value ?? ''))
      return value as NativeDevice;
  } catch {
    /* Default to bounded CPU inference. */
  }
  return 'CPU';
}
export function saveHyMtDevice(device: NativeDevice, openvino = false) {
  if (!(openvino ? ['AUTO', 'GPU', 'CPU', 'NPU'] : ['AUTO', 'GPU', 'CPU']).includes(device)) return;
  try {
    localStorage.setItem(
      openvino ? 'surfacetab.hymtOpenVinoDevice' : 'surfacetab.hymtDevice',
      device,
    );
  } catch {
    /* Session only. */
  }
}
export async function translateHyMt(
  text: string,
  target: string,
  device: NativeDevice,
  progress: (value: string) => void,
  signal: AbortSignal,
  backend: 'llama' | 'openvino' = 'llama',
) {
  text = normalizeTranslationText(text);
  if (
    !text ||
    text.length > 10000 ||
    !['zh-CN', 'en', 'ja', 'ko', 'fr'].includes(target) ||
    !(backend === 'openvino' ? ['AUTO', 'GPU', 'CPU', 'NPU'] : ['AUTO', 'GPU', 'CPU']).includes(
      device,
    )
  )
    throw new RejectedProviderRequest(
      t('Hy-MT2 输入过长或语言/设备无效，请缩短到 10000 字符以内。'),
    );
  await requireLocalModels([
    'hymt2-1-8b',
    backend === 'openvino' ? 'hymt-openvino-runtime' : 'unimumer-runtime',
  ]);
  signal.throwIfAborted();
  progress(t('正在连接本地 Hy-MT2…'));
  const health = await connectNativeTexo(signal);
  if (!health.capabilities?.includes('hymt2-translation-v1'))
    throw new Error(t('请重启或更新本地加速服务以使用 Hy-MT2'));
  noteNativeModel(health.capabilities.includes('release-idle'));
  progress(t('Hy-MT2 正在翻译；首次加载可能需要较长时间…'));
  const response = await fetch('http://127.0.0.1:8766/translate-hymt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      target,
      device,
      backend,
      idleReleaseSeconds: getModelIdleSeconds(),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  const data = await response.json();
  signal.throwIfAborted();
  if ([400, 422, 429, 499, 504].includes(response.status))
    throw new RejectedProviderRequest(
      typeof data.detail === 'string' ? data.detail : t('翻译失败'),
      response.status,
    );
  if (
    !response.ok ||
    typeof data.translation !== 'string' ||
    !data.translation.trim() ||
    !(backend === 'openvino' ? ['GPU', 'CPU', 'NPU'] : ['GPU', 'CPU']).includes(
      data.encoderDevice,
    ) ||
    data.decoderDevice !== data.encoderDevice ||
    !Number.isFinite(data.timing?.totalMs)
  )
    throw new Error(t('Hy-MT2 本地后端不可用'));
  return {
    text: data.translation,
    elapsed: data.timing.totalMs,
    device:
      backend === 'openvino'
        ? `${data.encoderDevice} (OpenVINO)`
        : data.encoderDevice === 'GPU'
          ? 'GPU (Vulkan)'
          : 'CPU',
    fallback: !!data.fallback,
    experimental: backend === 'openvino',
  };
}
