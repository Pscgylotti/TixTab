import { normalizeTranslationText } from './translationText';
let worker: Worker | undefined,
  cancel: (() => void) | undefined,
  idle: ReturnType<typeof setTimeout> | undefined;
export function releasePhonemizer() {
  const pending = cancel;
  cancel = undefined;
  worker?.terminate();
  worker = undefined;
  clearTimeout(idle);
  pending?.();
}
export function phonemizeSpeech(text: string, voice: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (cancel) return Promise.reject(new Error('Speech phonemization is already running'));
  if (!text.trim() || text.length > 4000)
    return Promise.reject(new Error('Speech requires 1 to 4000 characters'));
  clearTimeout(idle);
  worker ??= new Worker(new URL('./phonemize.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<number[][]>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      cancel = undefined;
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      worker?.terminate();
      worker = undefined;
      reject(new DOMException('Speech cancelled', 'AbortError'));
    };
    const fail = (error: Error) => {
      cleanup();
      releasePhonemizer();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new DOMException('Phonemization timed out', 'TimeoutError')),
      30000,
    );
    cancel = abort;
    signal.addEventListener('abort', abort, { once: true });
    worker!.onerror = (event) => fail(new Error(event.message || 'Phonemizer unavailable'));
    worker!.onmessage = ({ data }) => {
      if (data.type !== 'result') {
        fail(new Error(data.error));
        return;
      }
      cleanup();
      idle = setTimeout(releasePhonemizer, 120000);
      resolve(data.chunks);
    };
    worker!.postMessage({ text: normalizeTranslationText(text), voice, base: document.baseURI });
  });
}
