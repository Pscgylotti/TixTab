import type { ProviderFeature } from './providerSettings';
export type TaskPhase =
  'queued' | 'running' | 'fallback' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export type TaskErrorCode =
  'cancelled' | 'timeout' | 'busy' | 'invalid-input' | 'missing-model' | 'unavailable';
export type TaskResource = 'local' | 'remote' | 'system';
export type TaskIdentity = { provider: string; modelId: string; device: string };
export interface TaskSnapshot {
  id: string;
  feature: ProviderFeature;
  operation: 'run' | 'check';
  requested: string;
  phase: TaskPhase;
  attempt: number;
  provider: string;
  modelId: string;
  device: string;
  startedAt: number;
  endedAt?: number;
  elapsed: number;
  workElapsed?: number;
  fallback: boolean;
  error?: TaskErrorCode;
  status?: string;
}
export class ProviderTaskError extends Error {
  constructor(
    public code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name =
      code === 'cancelled'
        ? 'AbortError'
        : code === 'timeout'
          ? 'TimeoutError'
          : 'ProviderTaskError';
  }
}
/** A rejected native request must never trigger duplicate inference elsewhere. */
export class RejectedProviderRequest extends ProviderTaskError {
  readonly noFallback = true;
  constructor(message: string, status = 400) {
    super(
      status === 429
        ? 'busy'
        : status === 499
          ? 'cancelled'
          : status === 504
            ? 'timeout'
            : 'invalid-input',
      message,
    );
  }
}
type Waiter = {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
class Lane {
  private running = 0;
  private queue: Waiter[] = [];
  constructor(private limit: number) {}
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.running < this.limit) {
      this.running++;
      return Promise.resolve(this.release());
    }
    return new Promise((resolve, reject) => {
      const item: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          this.queue = this.queue.filter((w) => w !== item);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
    });
  }
  private release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      while (this.queue.length) {
        const item = this.queue.shift()!;
        item.signal.removeEventListener('abort', item.abort);
        if (item.signal.aborted) {
          item.reject(item.signal.reason);
          continue;
        }
        this.running++;
        item.resolve(this.release());
        break;
      }
    };
  }
}
export type TaskContext = {
  signal: AbortSignal;
  progress: (text: string) => void;
  partial: (text: string) => void;
  attempt: <T>(
    resource: TaskResource,
    identity: TaskIdentity,
    work: () => Promise<T>,
  ) => Promise<T>;
  complete: (identity: TaskIdentity, workElapsed?: number, fallback?: boolean) => void;
};
export function createTaskScheduler() {
  const lanes = { local: new Lane(1), remote: new Lane(2), system: new Lane(1) },
    active = new Map<string, { controller: AbortController; key: string }>(),
    listeners = new Set<() => void>();
  let snapshot: TaskSnapshot[] = [];
  const emit = () => listeners.forEach((fn) => fn());
  function update(id: string, patch: Partial<TaskSnapshot>) {
    snapshot = snapshot.map((s) => (s.id === id ? { ...s, ...patch } : s));
    emit();
  }
  function trim() {
    const terminal = snapshot.filter((s) => !active.has(s.id)).slice(0, 20),
      next = snapshot.filter((s) => active.has(s.id) || terminal.some((t) => t.id === s.id));
    if (next.length === snapshot.length) return false;
    snapshot = next;
    return true;
  }
  async function run<T>(
    feature: ProviderFeature,
    requested: string,
    work: (context: TaskContext) => Promise<T>,
    options: {
      signal?: AbortSignal;
      onProgress?: (text: string) => void;
      onPartial?: (text: string) => void;
      operation?: 'run' | 'check';
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const operation = options.operation || 'run',
      key = `${feature}:${operation}`;
    options.signal?.throwIfAborted();
    if ([...active.values()].some((a) => a.key === key))
      throw new ProviderTaskError('busy', '已有同类任务正在运行，请稍后重试');
    const id = crypto.randomUUID(),
      controller = new AbortController(),
      signal = controller.signal,
      started = performance.now();
    let attempts = 0,
      finished = false;
    const abort = () =>
      controller.abort(options.signal?.reason ?? new DOMException('已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const requestedTimeout = options.timeoutMs ?? 180000;
    const timer = setTimeout(
      () => controller.abort(new ProviderTaskError('timeout', '任务超时')),
      Number.isFinite(requestedTimeout)
        ? Math.min(180000, Math.max(2000, requestedTimeout))
        : 180000,
    );
    const cancelling = () => update(id, { phase: 'cancelling' });
    signal.addEventListener('abort', cancelling, { once: true });
    active.set(id, { controller, key });
    snapshot = [
      {
        id,
        feature,
        operation,
        requested,
        phase: 'queued',
        attempt: 0,
        provider: requested,
        modelId: '',
        device: '',
        startedAt: Date.now(),
        elapsed: 0,
        fallback: false,
      },
      ...snapshot,
    ];
    trim();
    emit();
    const context: TaskContext = {
      signal,
      progress: (text) => {
        if (!finished && !signal.aborted) {
          update(id, { status: text.slice(0, 300) });
          options.onProgress?.(text);
        }
      },
      partial: (text) => {
        if (!finished && !signal.aborted) options.onPartial?.(text);
      },
      attempt: async (resource, identity, execute) => {
        signal.throwIfAborted();
        if (finished) throw new ProviderTaskError('invalid-input', '任务已经结束');
        update(id, { phase: 'queued', ...identity, attempt: attempts, fallback: attempts > 0 });
        const release = await lanes[resource].acquire(signal);
        try {
          signal.throwIfAborted();
          attempts++;
          update(id, {
            phase: attempts > 1 ? 'fallback' : 'running',
            attempt: attempts,
            ...identity,
            fallback: attempts > 1,
          });
          const value = await execute();
          signal.throwIfAborted();
          return value;
        } finally {
          release();
        }
      },
      complete: (identity, workElapsed, fallback = false) => {
        if (!finished && !signal.aborted)
          update(id, { ...identity, workElapsed, fallback: fallback || attempts > 1 });
      },
    };
    try {
      const result = await work(context);
      signal.throwIfAborted();
      update(id, { phase: 'completed', endedAt: Date.now(), elapsed: performance.now() - started });
      return result;
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error,
        code = taskErrorCode(reason);
      update(id, {
        phase: code === 'cancelled' ? 'cancelled' : 'failed',
        error: code,
        endedAt: Date.now(),
        elapsed: performance.now() - started,
      });
      throw reason;
    } finally {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelling);
      options.signal?.removeEventListener('abort', abort);
      active.delete(id);
      if (trim()) emit();
    }
  }
  async function withLocalLane<T>(
    work: () => Promise<T>,
    signal = new AbortController().signal,
  ): Promise<T> {
    const release = await lanes.local.acquire(signal);
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  }
  return {
    run,
    withLocalLane,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => snapshot,
    cancel: (id: string) => {
      const job = active.get(id);
      if (!job || job.controller.signal.aborted) return false;
      job.controller.abort(new DOMException('已取消', 'AbortError'));
      return true;
    },
    clear: () => {
      snapshot = snapshot.filter((s) => active.has(s.id));
      emit();
    },
  };
}
export function taskErrorCode(error: unknown): TaskErrorCode {
  if (error instanceof ProviderTaskError) return error.code;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError') return 'timeout';
    if ('code' in error && ['busy', 'invalid-input', 'missing-model'].includes(String(error.code)))
      return error.code as TaskErrorCode;
  }
  return 'unavailable';
}
export const providerTasks = createTaskScheduler();
