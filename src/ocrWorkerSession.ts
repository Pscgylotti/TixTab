import { scheduleModelIdle } from './modelIdle';
import { requireLocalModels } from './modelLibrary';
import { ProviderTaskError } from './providerTasks';

type Session = {
  worker: Worker;
  ready: boolean;
  job: number;
  pending?: {
    id: string;
    resolve: (value: any) => void;
    reject: (error: unknown) => void;
    progress: (text: string) => void;
  };
};
let session: Session | undefined, active: object | undefined, idle: (() => void) | undefined;
export function releaseOcr(reason: unknown = new DOMException('已取消', 'AbortError')) {
  const old = session;
  session = undefined;
  idle?.();
  if (old) {
    old.worker.onmessage = null;
    old.worker.onerror = null;
    old.worker.terminate();
    const pending = old.pending;
    old.pending = undefined;
    pending?.reject(reason);
  }
}
function startSession() {
  // Tesseract.js 7.0.0 worker protocol, pinned in package.json. Owning the raw
  // worker lets cancellation also terminate language/core initialization; its
  // createWorker Promise does not expose that handle until initialization ends.
  const owned: Session = {
    worker: new Worker(new URL('ocr/worker.min.js', document.baseURI)),
    ready: false,
    job: 0,
  };
  let lastProgress = 0;
  owned.worker.onerror = (event) => {
    event.preventDefault?.();
    if (session === owned) releaseOcr(new Error(event.message || 'OCR worker unavailable'));
  };
  owned.worker.onmessage = ({ data }) => {
    const pending = owned.pending;
    if (session !== owned || !pending || data.jobId !== pending.id) return;
    if (data.status === 'progress') {
      if (performance.now() - lastProgress > 100) {
        lastProgress = performance.now();
        pending.progress(`本地 OCR · ${Math.round((Number(data.data?.progress) || 0) * 100)}%`);
      }
      return;
    }
    owned.pending = undefined;
    if (data.status === 'resolve') pending.resolve(data.data);
    else pending.reject(new Error('本地 OCR 识别失败'));
  };
  session = owned;
  return owned;
}
function command(
  owned: Session,
  action: string,
  payload: object,
  progress: (text: string) => void,
) {
  return new Promise<any>((resolve, reject) => {
    if (session !== owned) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const id = `ocr-${++owned.job}`;
    owned.pending = { id, resolve, reject, progress };
    try {
      const packet = { workerId: 'surfacetab-ocr', jobId: id, action, payload };
      const image =
        'image' in payload && payload.image instanceof Uint8Array ? payload.image : undefined;
      owned.worker.postMessage(packet, image ? [image.buffer] : []);
    } catch (error) {
      owned.pending = undefined;
      reject(error);
    }
  });
}
export async function localOcr(
  image: string,
  progress: (text: string) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await requireLocalModels(['tesseract']);
  signal?.throwIfAborted();
  if (active) throw new ProviderTaskError('busy', '已有 OCR 正在运行');
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(image))
    throw new ProviderTaskError('invalid-input', 'OCR 图片格式无效');
  const owner = {};
  active = owner;
  idle?.();
  const abort = () => releaseOcr(signal?.reason ?? new DOMException('已取消', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => releaseOcr(new DOMException('OCR 识别超时', 'TimeoutError')),
    180000,
  );
  try {
    const start = performance.now(),
      owned = session ?? startSession();
    progress('加载本地中英 OCR…');
    if (!owned.ready) {
      await command(
        owned,
        'load',
        {
          options: {
            lstmOnly: true,
            corePath: new URL('ocr/', document.baseURI).href,
            logging: false,
          },
        },
        progress,
      );
      signal?.throwIfAborted();
      await command(
        owned,
        'loadLanguage',
        {
          langs: 'eng+chi_sim',
          options: {
            langPath: new URL('models/ocr/', document.baseURI).href,
            cacheMethod: window.surfaceDesktop?.models ? 'none' : undefined,
            gzip: false,
            lstmOnly: true,
          },
        },
        progress,
      );
      signal?.throwIfAborted();
      await command(owned, 'initialize', { langs: 'eng+chi_sim', oem: 1, config: {} }, progress);
      signal?.throwIfAborted();
      owned.ready = true;
    }
    const binary = atob(image.slice(image.indexOf(',') + 1)),
      bytes = new Uint8Array(binary.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
    const result = await command(
      owned,
      'recognize',
      { image: bytes, options: {}, output: { text: true } },
      progress,
    );
    signal?.throwIfAborted();
    if (typeof result?.text !== 'string' || !Number.isFinite(result.confidence))
      throw new Error('本地 OCR 返回格式无效');
    idle = scheduleModelIdle(releaseOcr);
    return {
      text: result.text.trim(),
      confidence: result.confidence,
      elapsed: performance.now() - start,
    };
  } catch (error) {
    releaseOcr(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (active === owner) active = undefined;
  }
}
