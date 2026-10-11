import { requireLocalModels } from './modelLibrary';
type Result = { latex: string; elapsed: number; device: string };
let worker: Worker | null = null,
  idle: ReturnType<typeof setTimeout> | undefined,
  cancel: (() => void) | undefined;
export function releaseTexo() {
  const pending = cancel;
  cancel = undefined;
  worker?.terminate();
  worker = null;
  clearTimeout(idle);
  pending?.();
}
export async function recognizeTexo(
  image: string,
  device: 'wasm' | 'webgpu',
  progress: (text: string) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await requireLocalModels(['texo']);
  signal?.throwIfAborted();
  if (cancel) return Promise.reject(new Error('已有公式识别正在运行'));
  clearTimeout(idle);
  worker ??= new Worker(new URL('./texo.worker.ts', import.meta.url), { type: 'module' });
  const owned = worker;
  return new Promise<Result>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      cancel = undefined;
      owned.onmessage = null;
      owned.onerror = null;
    };
    const abort = () => {
      if (!done && worker === owned) releaseTexo();
    };
    const timeout = setTimeout(() => {
      cleanup();
      releaseTexo();
      reject(new Error('Texo 识别超时'));
    }, 180000);
    cancel = () => {
      cleanup();
      reject(new DOMException('公式识别已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    owned.onerror = (e) => {
      if (done) return;
      cleanup();
      releaseTexo();
      reject(new Error(e.message || 'Texo worker 启动失败'));
    };
    owned.onmessage = (e) => {
      if (done) return;
      if (e.data.type === 'progress') {
        progress(e.data.text);
        return;
      }
      cleanup();
      idle = setTimeout(releaseTexo, 120000);
      if (e.data.type === 'result') resolve(e.data);
      else reject(new Error(e.data.error));
    };
    try {
      owned.postMessage({
        image,
        device,
        modelBase: new URL('models/', document.baseURI).href,
        runtimeBase: new URL('ort/', document.baseURI).href,
      });
    } catch (error) {
      cleanup();
      releaseTexo();
      reject(error);
    }
  });
}
