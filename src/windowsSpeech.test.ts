import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { createWindowsSpeech, createSystemSpeechRouter } = createRequire(import.meta.url)(
  '../electron/windows-speech.cjs',
);
it('isolates native recognition, returns real levels, drains the final sentence and reuses the resident model', async () => {
  const commands: any[] = [];
  const progress: any[] = [];
  let child: any,
    stopped = false;
  const service = createWindowsSpeech({
    executable: 'native-speech',
    onProgress: (owner: unknown, value: unknown) => progress.push({ owner, value }),
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {
        child.killed = true;
        child.emit('close', 0);
      };
      child.stdin.on('data', (data: Buffer) => {
        const request = JSON.parse(data.toString());
        commands.push(request);
        child.stdout.write(JSON.stringify({ progress: { stage: 'Loading', value: 0.4 } }) + '\n');
        if (request.action === 'stop') stopped = true;
        if (request.action === 'start') stopped = false;
        const result =
          request.action === 'read'
            ? {
                ok: true,
                data: {
                  text: stopped ? 'final sentence' : '',
                  done: stopped,
                  ready: !stopped,
                  level: stopped ? 0 : 63,
                },
              }
            : { ok: true };
        queueMicrotask(() => child.stdout.write(JSON.stringify(result) + '\n'));
      });
      return child;
    },
  });
  const owner = {},
    other = {};
  const start = await service.run(owner, {
    action: 'start',
    engine: 'windows-ai',
    language: 'en-US',
  });
  expect(start.ok).toBe(true);
  expect(await service.run(other, { action: 'stop' })).toEqual({ ok: false, error: 'cancelled' });
  expect(child.killed).toBeUndefined();
  expect((await service.run(owner, { action: 'read', id: start.data.id })).data.level).toBe(63);
  expect((await service.run(owner, { action: 'stop' })).ok).toBe(true);
  expect((await service.run(owner, { action: 'read', id: start.data.id })).data).toMatchObject({
    text: 'final sentence',
    done: true,
    level: 0,
  });
  expect(child.killed).toBeUndefined();
  expect(commands.map((c) => c.action)).toEqual(['start', 'read', 'stop', 'read']);
  expect(progress).toHaveLength(4);
  expect(progress[0]).toEqual({ owner, value: { stage: 'Loading', value: 0.4 } });
  const originalChild = child;
  const reused = await service.run(other, {
    action: 'start',
    engine: 'windows-ai',
    language: 'en-US',
  });
  expect(reused.ok).toBe(true);
  expect(child).toBe(originalChild);
  expect(reused.data.id).not.toBe(start.data.id);
  expect((await service.run(owner, { action: 'stop' })).error).toBe('cancelled');
  service.dispose();
  expect(child.killed).toBe(true);
});
it('uses the configured idle time and rearms preference changes against the original idle start', async () => {
  vi.useFakeTimers();
  let child: any;
  const owner = {};
  const service = createWindowsSpeech({
    executable: 'native-speech',
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => child.emit('close', 0));
      child.stdin.on('data', (data: Buffer) => {
        const r = JSON.parse(data.toString());
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({ ok: true, data: r.action === 'read' ? { done: true } : {} }) + '\n',
          ),
        );
      });
      return child;
    },
  });
  try {
    const startPromise = service.run(owner, {
      action: 'start',
      engine: 'windows-ai',
      idleReleaseSeconds: 60,
    });
    await vi.advanceTimersByTimeAsync(0);
    const start = await startPromise;
    const read = service.run(owner, { action: 'read', id: start.data.id });
    await vi.advanceTimersByTimeAsync(100);
    expect((await read).data.done).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(child.kill).not.toHaveBeenCalled();
    await service.run(owner, { action: 'idle-policy', idleReleaseSeconds: 30 });
    await vi.advanceTimersByTimeAsync(9999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});
it('allows a cold AI model load beyond one minute and returns the stalled phase on timeout', async () => {
  vi.useFakeTimers();
  let child: any;
  const service = createWindowsSpeech({
    executable: 'native-speech',
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => child.emit('close', 0));
      return child;
    },
  });
  try {
    const start = service.run({}, { action: 'start', engine: 'windows-ai', language: 'en-US' });
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write(JSON.stringify({ progress: { stage: 'model-loading', value: 0.5 } }) + '\n');
    await vi.advanceTimersByTimeAsync(60001);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(539999);
    expect(await start).toMatchObject({
      ok: false,
      error: 'windows-speech-timeout',
      data: { stage: 'model-loading', action: 'start' },
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});
it('cancels loading immediately, protects other owners, and does not kill a replacement session', async () => {
  const children: any[] = [];
  const service = createWindowsSpeech({
    executable: 'native-speech',
    spawn: () => {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn(() => child.emit('close', 0));
      children.push(child);
      return child;
    },
  });
  const owner = {};
  try {
    const first = service.run(owner, { action: 'start', engine: 'windows-ai' });
    await Promise.resolve();
    expect((await service.run({}, { action: 'stop' })).error).toBe('cancelled');
    expect(children[0].kill).not.toHaveBeenCalled();
    const stop = service.run(owner, { action: 'stop' });
    const second = service.run(owner, { action: 'start', engine: 'windows-ai' });
    expect(await stop).toMatchObject({ ok: true, data: { cancelled: true } });
    expect((await first).error).toBe('cancelled');
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(children[1].kill).not.toHaveBeenCalled();
    service.cancel(owner);
    expect((await second).error).toBe('cancelled');
  } finally {
    service.dispose();
  }
});
it('keeps the selected native backend through stop/read and leaves legacy SAPI available', async () => {
  const calls: string[] = [];
  const fake = (id: string) => ({
    run: async (_owner: any, r: any) => {
      calls.push(id + ':' + r.action);
      return { ok: true, data: { done: r.action === 'read' } };
    },
    cancel: () => {},
    dispose: () => {},
  });
  const service = createSystemSpeechRouter(fake('legacy'), fake('native')),
    owner = {};
  await service.run(owner, { action: 'start', engine: 'windows-ai' });
  await service.run(owner, { action: 'stop' });
  await service.run(owner, { action: 'read' });
  await service.run(owner, { action: 'start', engine: 'system' });
  expect(calls).toEqual(['native:start', 'native:stop', 'native:read', 'legacy:start']);
  service.dispose();
});
