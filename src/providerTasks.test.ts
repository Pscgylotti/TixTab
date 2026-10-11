import { afterEach, expect, it, vi } from 'vitest';
import { createTaskScheduler, type TaskContext } from './providerTasks';
const identity = { provider: 'local', modelId: 'model', device: 'CPU' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

it('serializes model maintenance between local tasks without cancelling either', async () => {
  const tasks = createTaskScheduler(),
    inference = deferred<string>(),
    maintenance = deferred<string>(),
    events: string[] = [];
  const first = tasks.run('formula', 'native', (ctx) =>
    ctx.attempt('local', identity, async () => {
      events.push('first');
      return inference.promise;
    }),
  );
  const cleanup = tasks.withLocalLane(async () => {
    events.push('release');
    return maintenance.promise;
  });
  const next = tasks.run('ocr', 'local', (ctx) =>
    ctx.attempt('local', identity, async () => {
      events.push('next');
      return 'ok';
    }),
  );
  await vi.waitFor(() => expect(events).toEqual(['first']));
  inference.resolve('first');
  await first;
  await vi.waitFor(() => expect(events).toEqual(['first', 'release']));
  maintenance.resolve('done');
  await cleanup;
  await next;
  expect(events).toEqual(['first', 'release', 'next']);
});
it('cancels queued maintenance without releasing a running model', async () => {
  const tasks = createTaskScheduler(),
    gate = deferred<string>(),
    controller = new AbortController(),
    release = vi.fn(async () => {});
  const first = tasks.run('formula', 'native', (ctx) =>
    ctx.attempt('local', identity, () => gate.promise),
  );
  const cleanup = tasks.withLocalLane(release, controller.signal),
    rejected = expect(cleanup).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(release).not.toHaveBeenCalled();
  gate.resolve('ok');
  await first;
});

it('serializes local models while allowing two remote tasks', async () => {
  const tasks = createTaskScheduler(),
    local = deferred<string>(),
    remote = deferred<string>(),
    started: string[] = [];
  const work =
    (name: string, resource: 'local' | 'remote', promise: Promise<string>) => (ctx: TaskContext) =>
      ctx.attempt(resource, identity, async () => {
        started.push(name);
        return promise;
      });
  const a = tasks.run('formula', 'local', work('formula', 'local', local.promise));
  const b = tasks.run('ocr', 'local', work('ocr', 'local', Promise.resolve('ocr')));
  const c = tasks.run('translation', 'web', work('translation', 'remote', remote.promise));
  const d = tasks.run('speech', 'web', work('speech', 'remote', remote.promise));
  const e = tasks.run('ocr', 'web', work('check', 'remote', Promise.resolve('checked')), {
    operation: 'check',
  });
  await vi.waitFor(() => expect(started).toEqual(['formula', 'translation', 'speech']));
  remote.resolve('remote');
  await Promise.all([c, d, e]);
  expect(started).toContain('check');
  expect(started).not.toContain('ocr');
  local.resolve('formula');
  await Promise.all([a, b]);
  expect(started.at(-1)).toBe('ocr');
});
it('rejects duplicate feature work without disturbing the original', async () => {
  const tasks = createTaskScheduler(),
    gate = deferred<string>();
  const first = tasks.run('ocr', 'native', (ctx) =>
    ctx.attempt('local', identity, () => gate.promise),
  );
  await expect(tasks.run('ocr', 'web', async () => '')).rejects.toMatchObject({ code: 'busy' });
  expect(tasks.getSnapshot()).toHaveLength(1);
  gate.resolve('ok');
  await expect(first).resolves.toBe('ok');
});
it('removes cancelled queued work and never calls its adapter', async () => {
  const tasks = createTaskScheduler(),
    gate = deferred<string>(),
    execute = vi.fn(async () => 'bad');
  const first = tasks.run('formula', 'local', (ctx) =>
    ctx.attempt('local', identity, () => gate.promise),
  );
  const queued = tasks.run('ocr', 'local', (ctx) => ctx.attempt('local', identity, execute));
  const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  const id = tasks.getSnapshot()[0].id;
  expect(tasks.cancel(id)).toBe(true);
  await rejected;
  expect(tasks.getSnapshot().find((s) => s.id === id)).toMatchObject({
    phase: 'cancelled',
    attempt: 0,
  });
  expect(execute).not.toHaveBeenCalled();
  gate.resolve('ok');
  await first;
  await tasks.run('speech', 'local', (ctx) => ctx.attempt('local', identity, async () => 'next'));
});
it('keeps the local lane occupied until cancelled adapter cleanup really settles', async () => {
  const tasks = createTaskScheduler(),
    cleanup = deferred<string>(),
    started = vi.fn();
  const first = tasks.run('formula', 'local', (ctx) =>
    ctx.attempt('local', identity, () => cleanup.promise),
  );
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(tasks.getSnapshot()[0].phase).toBe('running'));
  tasks.cancel(tasks.getSnapshot()[0].id);
  const next = tasks.run('ocr', 'local', (ctx) =>
    ctx.attempt('local', identity, async () => {
      started();
      return 'next';
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(started).not.toHaveBeenCalled();
  cleanup.resolve('late');
  await rejected;
  await next;
  expect(started).toHaveBeenCalledOnce();
});
it('times out with a stable error and releases the lane after cleanup', async () => {
  vi.useFakeTimers();
  const tasks = createTaskScheduler();
  const pending = tasks.run(
    'ocr',
    'native',
    (ctx) =>
      ctx.attempt(
        'local',
        identity,
        () =>
          new Promise((_, reject) =>
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }),
          ),
      ),
    { timeoutMs: 2000 },
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(tasks.getSnapshot()[0]).toMatchObject({ phase: 'failed', error: 'timeout' });
  await tasks.run('formula', 'local', (ctx) => ctx.attempt('local', identity, async () => 'ok'));
});
it('blocks late output and metadata after completion or cancellation', async () => {
  const tasks = createTaskScheduler(),
    partial = vi.fn(),
    progress = vi.fn();
  let saved!: TaskContext;
  await tasks.run(
    'translation',
    'web',
    async (ctx) => {
      saved = ctx;
      ctx.partial('current');
      return 'ok';
    },
    { onPartial: partial, onProgress: progress },
  );
  const completed = tasks.getSnapshot();
  saved.partial('late');
  saved.progress('late');
  saved.complete({ provider: 'late', modelId: 'late', device: 'late' });
  expect(partial).toHaveBeenCalledExactlyOnceWith('current');
  expect(progress).not.toHaveBeenCalled();
  expect(tasks.getSnapshot()).toBe(completed);
  await expect(saved.attempt('remote', identity, async () => 'late')).rejects.toMatchObject({
    code: 'invalid-input',
  });
});
it('keeps 20 terminal snapshots plus active work, and clear preserves active tasks', async () => {
  const tasks = createTaskScheduler(),
    gate = deferred<string>();
  let notified = tasks.getSnapshot();
  const unsub = tasks.subscribe(() => {
    notified = tasks.getSnapshot();
  });
  const running = tasks.run('translation', 'local', (ctx) =>
    ctx.attempt('local', identity, () => gate.promise),
  );
  for (let i = 0; i < 25; i++) await tasks.run('ocr', 'web', async () => `private-result-${i}`);
  expect(tasks.getSnapshot()).toHaveLength(21);
  expect(notified).toBe(tasks.getSnapshot());
  expect(JSON.stringify(tasks.getSnapshot())).not.toContain('private-result');
  tasks.clear();
  expect(tasks.getSnapshot()).toHaveLength(1);
  expect(tasks.getSnapshot()[0].feature).toBe('translation');
  gate.resolve('ok');
  await running;
  unsub();
});
it('does not record tasks already cancelled by their owner', async () => {
  const tasks = createTaskScheduler(),
    controller = new AbortController();
  controller.abort();
  await expect(
    tasks.run('ocr', 'native', async () => '', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(tasks.getSnapshot()).toEqual([]);
});
