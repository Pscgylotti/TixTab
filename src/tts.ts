import { scheduleModelIdle } from './modelIdle';
import { normalizeTranslationText } from './translationText';
import { requireLocalModels } from './modelLibrary';
import { ProviderTaskError } from './providerTasks';
let worker: Worker | undefined,
  loaded = '',
  cancel: (() => void) | undefined,
  idle: (() => void) | undefined;
export function releaseTts() {
  const pending = cancel;
  cancel = undefined;
  worker?.terminate();
  worker = undefined;
  loaded = '';
  idle?.();
  pending?.();
}
export async function localSpeech(
  text: string,
  progress: (text: string) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (cancel) return Promise.reject(new ProviderTaskError('busy', '已有语音合成正在运行'));
  if (!text.trim() || text.length > 4000)
    return Promise.reject(
      new ProviderTaskError('invalid-input', '请将朗读选区缩短至 4000 字符以内'),
    );
  const voice = /[\u4e00-\u9fff]/.test(text) ? 'zh_CN-huayan-x_low' : 'en_US-lessac-low';
  await requireLocalModels([voice.startsWith('zh_') ? 'piper-zh' : 'piper-en', 'piper-runtime']);
  signal?.throwIfAborted();
  if (cancel) throw new ProviderTaskError('busy', '已有语音合成正在运行');
  if (loaded && loaded !== voice) releaseTts();
  idle?.();
  worker ??= new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
  loaded = voice;
  return new Promise<{ audio: Blob; elapsed: number }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      cancel = undefined;
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      worker?.terminate();
      worker = undefined;
      loaded = '';
      reject(new DOMException('朗读已取消', 'AbortError'));
    };
    const timer = setTimeout(abort, 90000);
    cancel = abort;
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker!.onerror = (e) => {
      cleanup();
      releaseTts();
      reject(new Error(e.message || '语音模型启动失败'));
    };
    worker!.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        progress(data.text);
        return;
      }
      cleanup();
      idle = scheduleModelIdle(releaseTts);
      if (data.type === 'result') resolve(data);
      else {
        releaseTts();
        reject(new Error(data.error));
      }
    };
    worker!.postMessage({ text: normalizeTranslationText(text), voice, base: document.baseURI });
  });
}
