import type { BitmapRecognition } from './bitmapOcr';
import { getModelIdleSeconds } from './modelIdle';
import { t } from './i18n';
export interface WindowsAiOcrBridge {
  run(request: {
    action: 'status' | 'open' | 'recognize' | 'close' | 'register';
    id: string;
    image?: string;
    idleSeconds?: number;
  }): Promise<{
    ok: boolean;
    state?: string;
    error?: string;
    hresult?: string;
    stage?: string;
    data?: BitmapRecognition;
  }>;
}
const messages: Record<string, string> = {
  'windows-ai-registration-failed':
    'Windows AI OCR 身份注册失败。正式安装需要受信任的签名身份包；开发注册仅在系统已启用开发者模式时可用。',
  'windows-ai-identity':
    'Windows AI OCR 组件缺少应用身份权限。请安装声明 systemAIModels 权限的签名组件；普通 EXE 无法直接调用。',
  'windows-ai-missing': 'Windows AI OCR 组件未安装，请使用包含该组件的桌面版本。',
  'windows-ai-busy': '已有本地推理正在运行，请稍后重试',
  'windows-ai-timeout': 'Windows AI OCR 超时，请检查系统模型下载状态。',
  'windows-ai-crashed': 'Windows AI OCR 进程已退出，请重试。',
  'model-not-ready': 'Windows AI OCR 系统模型尚未就绪，请检查 Windows 更新与 AI 模型设置。',
  NotSupportedOnCurrentSystem:
    '此设备或 Windows 版本不支持 Windows AI OCR，需要受支持的 NPU 与系统模型。',
  DisabledByUser: 'Windows AI 功能已被系统设置禁用。',
  'image-limit': '图片超过 400 万像素，请缩小区域。',
};
export function windowsAiError(error?: string, hresult?: string, stage?: string) {
  const stages: Record<string, string> = {
    readiness: '检查系统模型',
    'prepare-model': '准备系统模型',
    'create-model': '创建识别器',
    'load-image': '加载图片',
    'decode-image': '解码图片',
    'image-buffer': '转换图片',
    recognize: '执行识别',
    'read-result': '读取识别结果',
  };
  return (
    (error === 'windows-ai-unavailable' && stage && stages[stage]
      ? t('Windows AI OCR 在“{0}”阶段失败。', t(stages[stage]))
      : t(
          messages[error || ''] ||
            'Windows AI OCR 不可用。请检查系统版本、系统模型和应用身份权限。',
        )) + (hresult ? ` (${hresult})` : '')
  );
}
export async function withWindowsAiOcr<T>(
  signal: AbortSignal,
  work: (recognize: (image: string, lane: number) => Promise<BitmapRecognition>) => Promise<T>,
) {
  const bridge = window.surfaceDesktop?.windowsAiOcr;
  if (!bridge) throw Error(t('Windows AI OCR 仅适用于 Windows 桌面版本。'));
  const id = crypto.randomUUID(),
    jobs = new Set<Promise<BitmapRecognition>>();
  const close = () => bridge.run({ action: 'close', id }).catch(() => {});
  const cancel = () => {
    void close();
  };
  const checked = async (request: Parameters<WindowsAiOcrBridge['run']>[0]) => {
    signal.throwIfAborted();
    const result = await bridge.run(request);
    signal.throwIfAborted();
    if (!result.ok) throw Error(windowsAiError(result.error, result.hresult, result.stage));
    return result;
  };
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await checked({ action: 'open', id, idleSeconds: getModelIdleSeconds() });
    return await work((image) => {
      const job = (async () => {
        const start = performance.now(),
          result = await checked({ action: 'recognize', id, image });
        if (
          !result.data ||
          typeof result.data.text !== 'string' ||
          !Array.isArray(result.data.lines)
        )
          throw Error(t('OCR 返回格式无效'));
        return { ...result.data, timing: { totalMs: performance.now() - start } };
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
    await close();
    await Promise.allSettled([...jobs]);
  }
}
