import { t } from './i18n';
export interface ProviderHttpRequest {
  id: string;
  url: string;
  method: 'HEAD' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  kind: 'text' | 'speech';
}
type RelayFailure = { ok: false; error: string };
export interface ProviderHttpBridge {
  start: (
    request: ProviderHttpRequest,
  ) => Promise<
    RelayFailure | { ok: true; status: number; headers: Record<string, string>; body: boolean }
  >;
  read: (
    id: string,
  ) => Promise<
    RelayFailure | { ok: true; done: true } | { ok: true; done: false; bytes: Uint8Array }
  >;
  cancel: (id: string) => Promise<unknown>;
}
export class ProviderTransportInputError extends Error {
  readonly code = 'invalid-input';
}
function relayError(code: string) {
  if (code === 'timeout') return new DOMException('Request timed out', 'TimeoutError');
  if (code === 'aborted') return new DOMException('Request canceled', 'AbortError');
  if (code === 'invalid' || code === 'input-limit')
    return new ProviderTransportInputError(t('接口请求格式无效或输入过大'));
  if (code === 'busy')
    return new ProviderTransportInputError(t('桌面接口请求已达并发上限，请稍后重试'));
  return new Error('Provider connection failed');
}
function safeError(error: unknown, signal: AbortSignal) {
  return signal.aborted
    ? signal.reason
    : error instanceof ProviderTransportInputError ||
        (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
      ? error
      : new Error('Provider connection failed');
}
export function usesDesktopRelay() {
  return typeof window !== 'undefined' && !!window.surfaceDesktop?.providerHttp;
}
export async function providerFetch(
  url: URL,
  init: { method: 'HEAD' | 'POST'; headers: Headers; body?: string; signal: AbortSignal },
  kind: 'text' | 'speech',
  timeoutMs: number,
): Promise<Response> {
  const bridge = typeof window !== 'undefined' ? window.surfaceDesktop?.providerHttp : undefined;
  if (!bridge)
    return fetch(url, {
      ...init,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  const signal = init.signal,
    id = crypto.randomUUID();
  signal.throwIfAborted();
  let ended = false;
  const abort = () => {
    void bridge.cancel(id).catch(() => {});
  };
  const release = () => {
    ended = true;
    signal.removeEventListener('abort', abort);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await bridge.start({
      id,
      url: url.href,
      method: init.method,
      headers: Object.fromEntries(init.headers),
      body: init.body,
      kind,
      timeoutMs,
    });
    signal.throwIfAborted();
    if (!result.ok) throw relayError(result.error);
    if (!result.body) {
      release();
      return new Response(null, { status: result.status, headers: result.headers });
    }
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const chunk = await bridge.read(id);
            signal.throwIfAborted();
            if (ended) return;
            if (!chunk.ok) throw relayError(chunk.error);
            if (chunk.done) {
              release();
              controller.close();
            } else controller.enqueue(chunk.bytes);
          } catch (error) {
            release();
            abort();
            controller.error(safeError(error, signal));
          }
        },
        async cancel() {
          release();
          await bridge.cancel(id).catch(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: result.status, headers: result.headers });
  } catch (error) {
    release();
    abort();
    throw safeError(error, signal);
  }
}
