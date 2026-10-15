import { abortWait } from './abortWait';
import { uid } from './model';
export type LocalToolEngine = 'uvdoc' | 'audiveris' | 'homr';
export interface LocalDocumentToolsBridge {
  run(request: {
    action: 'status' | 'diagnostics' | 'prepare' | 'correct' | 'recognize' | 'cancel';
    id?: string;
    engine?: LocalToolEngine;
    mode?: 'scan' | 'photo' | 'auto';
    device?: 'AUTO' | 'CPU' | 'GPU' | 'NPU';
    image?: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    logs?: string;
    data?: {
      document?: boolean;
      device?: string;
      fallback?: string | null;
      compileMs?: number;
      inferenceMs?: number;
      mappingMs?: number;
      homr?: boolean;
      audiveris?: boolean;
      image?: string;
      musicxml?: string;
      systems?: import('./musicScore').ScoreRect[];
      noteLocations?: import('./musicScore').ScoreLocations;
      width?: number;
      height?: number;
      engine?: 'audiveris' | 'homr';
      model?: string;
      angle?: number;
      perspective?: boolean;
    };
  }>;
}
export const localToolErrors: Record<string, string> = {
  'runtime-missing': '请先准备本地组件。',
  'missing-model': '请先下载本地模型。',
  'image-size': '图片超过处理尺寸限制。',
  'no-score': '未识别到可播放的五线谱，请检查图片清晰度或尝试另一后端。',
  'score-format': '五线谱结果格式无效。',
  'score-limit': '此页识谱结果过多，请分区域处理。',
  'local-tool-failed': '本地处理失败，请查看诊断信息。',
  'recognition-failed': '本地识别未完成，请查看诊断信息。',
  'correction-failed': '图像矫正失败，请查看诊断信息。',
  'device-unavailable': '所选设备不可用，请切换到 CPU 或自动。',
  'device-incompatible': '模型无法在所选设备运行，请切换到 CPU。',
  'component-invalid': '本地组件不完整，请重新准备。',
  timeout: '处理超时，已释放当前任务。',
  busy: '已有本地文档任务正在运行。',
  cancelled: '已取消',
};
export async function runLocalDocumentTool(
  request: Parameters<LocalDocumentToolsBridge['run']>[0],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const bridge = window.surfaceDesktop?.documentTools;
  if (!bridge) throw Error('runtime-missing');
  const id = uid(),
    cancel = () => void bridge.run({ action: 'cancel', id });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await abortWait(bridge.run({ ...request, id }), signal);
    signal.throwIfAborted();
    if (!result.ok) throw Error(result.error || 'local-tool-failed');
    return result.data;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
