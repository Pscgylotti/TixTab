import type { BitmapRecognition } from './bitmapOcr';
import { createOcrPixelBudget, ocrInputPixels } from './ocrPixelBudget';
import { getModelIdleSeconds } from './modelIdle';
import { t } from './i18n';
export type NativeCppVariant =
  'fast' | 'mixed-fast' | 'best' | 'mixed-best' | 'npu-fast' | 'npu-best';
export const nativeCppVariant = (value: string): NativeCppVariant =>
  ['fast', 'best', 'mixed-best', 'npu-fast', 'npu-best'].includes(value)
    ? (value as NativeCppVariant)
    : 'mixed-fast';
export const nativeCppModels = (value: NativeCppVariant) =>
  value === 'best' || value.startsWith('npu-')
    ? ['tesseract-openvino']
    : value === 'mixed-best'
      ? ['tesseract-openvino', 'tesseract-openvino-zh']
      : ['tesseract'];
export interface NativeCppOcrBridge {
  run(request: {
    action: 'open' | 'recognize' | 'close' | 'status';
    id?: string;
    variant?: NativeCppVariant;
    count?: number;
    idleSeconds?: number;
    image?: string;
  }): Promise<{
    ok: boolean;
    available?: boolean;
    npuAvailable?: boolean;
    error?: string;
    data?: BitmapRecognition & { device?: string };
  }>;
}
const messages: Record<string, string> = {
  'native-ocr-missing': '原生 OCR 组件未准备，请使用包含原生后端的桌面版本。',
  'missing-model': '本地模型尚未安装，请在设置的“本地模型管理”中按需下载。',
  'image-limit': '图片超过原生 OCR 的 400 万像素限制，请缩小区域。',
  'native-ocr-crashed': '原生 OCR 进程已退出，请重试。',
  'native-ocr-timeout': '任务超时',
  'native-ocr-busy': '已有本地推理正在运行，请稍后重试',
  'native-npu-missing': '原生 NPU 实验组件或模型尚未准备。',
};
export async function withNativeCppOcr<T>(
  variant: NativeCppVariant,
  count: number,
  signal: AbortSignal,
  work: (recognize: (image: string, lane: number) => Promise<BitmapRecognition>) => Promise<T>,
) {
  const bridge = window.surfaceDesktop?.nativeOcr;
  if (!bridge) throw Error(t('原生 OCR 仅适用于桌面版本。'));
  const id = crypto.randomUUID(),
    jobs = new Set<Promise<BitmapRecognition>>(),
    budget = createOcrPixelBudget();
  const cancel = () => {
    void bridge.run({ action: 'close', id }).catch(() => {});
  };
  const checked = async (request: Parameters<NativeCppOcrBridge['run']>[0]) => {
    const result = await bridge.run(request);
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error?.startsWith('openvino-npu-error-'))
        throw Error(t('原生 NPU 编译或推理失败：{0}；未回退 CPU。', result.error));
      throw Error(t(messages[result.error || ''] || '原生 OCR 识别失败，请重试。'));
    }
    return result;
  };
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await checked({
      action: 'open',
      id,
      variant,
      count: variant.startsWith('npu-') ? 1 : count,
      idleSeconds: getModelIdleSeconds(),
    });
    return await work((image) => {
      const job = (async () => {
        const release = await budget(ocrInputPixels(image), signal);
        try {
          signal.throwIfAborted();
          const start = performance.now(),
            result = await checked({ action: 'recognize', id, image });
          if (
            !result.data ||
            typeof result.data.text !== 'string' ||
            !Array.isArray(result.data.lines)
          )
            throw Error(t('原生 OCR 返回格式无效'));
          return {
            ...result.data,
            timing: { ...result.data.timing, totalMs: performance.now() - start },
          };
        } finally {
          release();
        }
      })();
      jobs.add(job);
      void job.then(
        () => jobs.delete(job),
        () => jobs.delete(job),
      );
      return job;
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await bridge.run({ action: 'close', id }).catch(() => {});
    await Promise.allSettled([...jobs]);
  }
}
