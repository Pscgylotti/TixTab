import { connectNativeTexo, type NativeDevice } from './nativeTexo';
import { requireLocalModels } from './modelLibrary';
import { noteNativeModel } from './nativeResources';
import { RejectedProviderRequest } from './providerTasks';
import { t } from './i18n';

export async function recognizeUnimumer(
  image: string,
  device: NativeDevice,
  progress: (value: string) => void,
  signal: AbortSignal,
) {
  await requireLocalModels(['unimumer-qwen3-vl-2b', 'unimumer-runtime']);
  signal.throwIfAborted();
  progress(t('正在连接本地 Uni-MuMER…'));
  const health = await connectNativeTexo(signal);
  if (!health.capabilities?.includes('unimumer-experimental'))
    throw new Error(t('请重启或更新本地加速服务以使用 Uni-MuMER'));
  noteNativeModel(!!health.capabilities.includes('release-idle'));
  progress(t('Uni-MuMER 识别中；首次加载可能需要较长时间…'));
  const response = await fetch('http://127.0.0.1:8766/recognize-unimumer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, device }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
  });
  const data = await response.json();
  if ([400, 422, 429, 499, 504].includes(response.status))
    throw new RejectedProviderRequest(
      typeof data.detail === 'string' ? data.detail : t('识别失败'),
      response.status,
    );
  if (
    !response.ok ||
    typeof data.latex !== 'string' ||
    !['GPU', 'CPU'].includes(data.encoderDevice) ||
    !Number.isFinite(data.timing?.totalMs)
  )
    throw new Error(t('Uni-MuMER 本地后端不可用'));
  return {
    text: data.latex,
    elapsed: data.timing.totalMs,
    device: data.encoderDevice === 'GPU' ? 'GPU (Vulkan)' : 'CPU',
    fallback: !!data.fallback,
    experimental: true,
  };
}
