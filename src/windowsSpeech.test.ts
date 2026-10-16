import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { createWindowsSpeech, createSystemSpeechRouter } = createRequire(import.meta.url)(
  '../electron/windows-speech.cjs',
);
it('isolates native recognition, drains the final sentence and disposes the worker', async () => {
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
        const result =
          request.action === 'read'
            ? {
                ok: true,
                data: { text: stopped ? 'final sentence' : '', done: stopped, ready: !stopped },
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
  expect((await service.run(owner, { action: 'stop' })).ok).toBe(true);
  expect((await service.run(owner, { action: 'read', id: start.data.id })).data).toMatchObject({
    text: 'final sentence',
    done: true,
  });
  expect(child.killed).toBe(true);
  expect(commands.map((c) => c.action)).toEqual(['start', 'stop', 'read']);
  expect(progress).toHaveLength(3);
  expect(progress[0]).toEqual({ owner, value: { stage: 'Loading', value: 0.4 } });
  service.dispose();
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
