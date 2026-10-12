import { scheduleModelIdle } from './modelIdle';
import { isLocalTranslationNoop, normalizeTranslationText } from './translationText';
import { requireLocalModels } from './modelLibrary';
let worker: Worker | null = null,
  loadedDirection = '',
  idle: (() => void) | undefined,
  cancel: (() => void) | undefined;
export function releaseTranslation() {
  cancel?.();
  cancel = undefined;
  worker?.terminate();
  worker = null;
  loadedDirection = '';
  idle?.();
}
export const translationReady = (target: string) =>
  !!worker && !cancel && loadedDirection === (target === 'en' ? 'zh-en' : 'en-zh');
export async function localTranslate(
  text: string,
  target: string,
  progress: (text: string) => void,
  signal?: AbortSignal,
) {
  text = normalizeTranslationText(text);
  if (!['zh-CN', 'en'].includes(target))
    return Promise.reject(new Error('本地模型目前仅支持英文→中文、中文→英文'));
  if (!text || text.length > 10000)
    return Promise.reject(new Error('请将本地翻译选区缩短至 10000 字符以内'));
  const direction = target === 'en' ? 'zh-en' : 'en-zh';
  if (isLocalTranslationNoop(text, target)) return Promise.resolve({ text, elapsed: 0 });
  await requireLocalModels([target === 'en' ? 'opus-zh-en' : 'opus-en-zh']);
  signal?.throwIfAborted();
  if (cancel) return Promise.reject(new Error('已有本地翻译正在运行'));
  idle?.();
  worker ??= new Worker(new URL('./translate.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<{ text: string; elapsed: number }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      cancel = undefined;
    };
    const abort = () => {
      cleanup();
      worker?.terminate();
      worker = null;
      loadedDirection = '';
      reject(new DOMException('翻译已取消', 'AbortError'));
    };
    const timer = setTimeout(abort, 180000);
    cancel = abort;
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker!.onerror = (e) => {
      cleanup();
      worker?.terminate();
      worker = null;
      loadedDirection = '';
      reject(new Error(e.message || '翻译模型启动失败'));
    };
    worker!.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        progress(data.text);
        return;
      }
      cleanup();
      idle = scheduleModelIdle(releaseTranslation);
      if (data.type === 'result') {
        loadedDirection = direction;
        resolve(data);
      } else {
        loadedDirection = '';
        reject(new Error(data.error));
      }
    };
    worker!.postMessage({
      text,
      direction,
      modelBase: new URL('models/', document.baseURI).href,
      runtimeBase: new URL('ort/', document.baseURI).href,
    });
  });
}
