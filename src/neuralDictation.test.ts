import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { createNeuralDictation } = createRequire(import.meta.url)(
  '../electron/neural-dictation.cjs',
);
function fixture(source = 'downloaded') {
  const children: any[] = [];
  const models = {
    list: async () => [
      { id: 'sensevoice-small', source },
      { id: 'whisper-small', source },
    ],
  };
  const system = {
    run: async () => ({ ok: true, data: { id: 'system' } }),
    cancel: () => {},
    dispose: () => {},
  };
  const service = createNeuralDictation({
    backend: 'C:/backend',
    runtime: 'C:/runtime',
    exists: () => true,
    modelRoot: 'C:/models',
    bundled: 'C:/bundle',
    models,
    system,
    spawnProcess: (_exe: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {
        child.killed = true;
        child.emit('close', 0);
      };
      child.args = args;
      children.push(child);
      return child;
    },
  });
  return { service, children, models, owner: {} };
}
describe('local neural dictation controller', () => {
  it('requires a completed model and rejects untrusted engines/languages before spawning', async () => {
    const f = fixture('missing');
    try {
      expect(
        (
          await f.service.run(f.owner, {
            action: 'start',
            engine: 'sensevoice-small',
            language: 'zh-CN',
          })
        ).error,
      ).toBe('model-missing');
      expect(
        (await f.service.run(f.owner, { action: 'start', engine: 'custom.exe', language: 'zh-CN' }))
          .error,
      ).toBe('invalid');
      expect(
        (
          await f.service.run(f.owner, {
            action: 'start',
            engine: 'whisper-small',
            language: 'en-US',
            device: ';shutdown',
          })
        ).error,
      ).toBe('invalid');
      expect(f.children).toHaveLength(0);
    } finally {
      f.service.dispose();
    }
  });
  it('flushes the final phrase on stop, isolates owners, and reuses a warm model', async () => {
    const f = fixture();
    try {
      const request = {
        action: 'start',
        engine: 'whisper-small',
        language: 'en-US',
        device: 'NPU',
      };
      const first = await f.service.run(f.owner, request),
        child = f.children[0];
      expect(child.args).toContain('NPU');
      child.stdout.write(
        JSON.stringify({ event: 'loaded', device: 'NPU' }) +
          '\n' +
          JSON.stringify({ event: 'ready', id: first.data.id }) +
          '\n',
      );
      expect((await f.service.run({}, { action: 'read', id: first.data.id })).error).toBe(
        'cancelled',
      );
      await f.service.run({}, { action: 'stop' });
      expect(child.stdin.read().toString()).not.toContain('stop');
      await f.service.run(f.owner, { action: 'stop' });
      expect(child.stdin.read().toString()).toContain('stop');
      child.stdout.write(
        JSON.stringify({ event: 'text', id: first.data.id, text: '最后一句 final phrase' }) +
          '\n' +
          JSON.stringify({ event: 'done', id: first.data.id }) +
          '\n',
      );
      expect(
        (await f.service.run(f.owner, { action: 'read', id: first.data.id })).data,
      ).toMatchObject({ text: '最后一句 final phrase', done: true, device: 'NPU' });
      const second = await f.service.run(f.owner, { ...request, language: 'zh-CN' });
      expect(second.ok).toBe(true);
      expect(f.children).toHaveLength(1);
      child.stdout.write(
        JSON.stringify({ event: 'ready', id: first.data.id }) +
          '\n' +
          JSON.stringify({ event: 'text', id: first.data.id, text: 'stale' }) +
          '\n' +
          JSON.stringify({ event: 'ready', id: second.data.id }) +
          '\n',
      );
      const next = await f.service.run(f.owner, { action: 'read', id: second.data.id });
      expect(next.data.text).toBe('');
      expect(next.data.ready).toBe(true);
      f.service.cancel(f.owner);
      expect(child.killed).not.toBe(true);
      expect(child.stdin.read().toString()).toContain('stop');
    } finally {
      f.service.dispose();
    }
  });
  it('cancel drains a loaded recorder, discards late text, and preserves it for the next use', async () => {
    const f = fixture();
    try {
      const request = {
        action: 'start',
        engine: 'whisper-small',
        language: 'zh-CN',
        device: 'NPU',
      };
      const first = await f.service.run(f.owner, request);
      const child = f.children[0];
      child.stdout.write(JSON.stringify({ event: 'loaded', device: 'NPU' }) + '\n');
      f.service.cancel({});
      expect(child.stdin.read().toString()).not.toContain('stop');
      f.service.cancel(f.owner);
      child.stdout.write(
        JSON.stringify({ event: 'text', id: first.data.id, text: 'discard me' }) + '\n',
      );
      expect(
        (await f.service.run(f.owner, { action: 'read', id: first.data.id })).data,
      ).toMatchObject({ done: true, text: '' });
      expect((await f.service.run(f.owner, request)).error).toBe('busy');
      child.stdout.write(JSON.stringify({ event: 'done', id: first.data.id }) + '\n');
      f.service.cancel(f.owner); // Closing an already idle panel is harmless.
      f.models.list = () => {
        throw Error('Warm start must not scan model files');
      };
      expect((await f.service.run(f.owner, request)).ok).toBe(true);
      expect(f.children).toHaveLength(1);
      expect(child.killed).not.toBe(true);
    } finally {
      f.service.dispose();
    }
  });
  it('passes the idle deadline at launch and updates a warm worker without interrupting recording', async () => {
    const f = fixture();
    try {
      expect(
        (await f.service.run(f.owner, { action: 'idle-policy', idleReleaseSeconds: 29 })).error,
      ).toBe('invalid');
      const result = await f.service.run(f.owner, {
        action: 'start',
        engine: 'whisper-small',
        language: 'en-US',
        idleReleaseSeconds: 600,
      });
      expect(result.ok).toBe(true);
      const child = f.children[0];
      expect(
        child.args.slice(
          child.args.indexOf('--idle-seconds'),
          child.args.indexOf('--idle-seconds') + 2,
        ),
      ).toEqual(['--idle-seconds', '600']);
      child.stdin.read();
      await f.service.run(f.owner, { action: 'idle-policy', idleReleaseSeconds: 1800 });
      expect(JSON.parse(child.stdin.read().toString())).toEqual({
        action: 'idle-policy',
        idleReleaseSeconds: 1800,
      });
      expect(child.killed).not.toBe(true);
    } finally {
      f.service.dispose();
    }
  });
  it('cancels compilation without opening a microphone and reports bounded fatal errors', async () => {
    const f = fixture();
    try {
      const first = await f.service.run(f.owner, {
        action: 'start',
        engine: 'sensevoice-small',
        language: 'zh-CN',
        device: 'GPU',
      });
      expect(f.children[0].args).toContain('CPU');
      await f.service.run(f.owner, { action: 'stop' });
      expect(f.children[0].killed).toBe(true);
      expect(
        (await f.service.run(f.owner, { action: 'read', id: first.data.id })).data,
      ).toMatchObject({ done: true, error: '' });
      const second = await f.service.run(f.owner, {
        action: 'start',
        engine: 'sensevoice-small',
        language: 'zh-CN',
      });
      f.children[1].stdout.write(
        JSON.stringify({ event: 'fatal', error: 'private raw exception' }) + '\n',
      );
      expect(
        (await f.service.run(f.owner, { action: 'read', id: second.data.id })).data.error,
      ).toBe('runtime');
    } finally {
      f.service.dispose();
    }
  });
  it('does not launch after the owning page cancels a pending model lookup', async () => {
    const f = fixture();
    let complete: any;
    f.models.list = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    try {
      const pending = f.service.run(f.owner, {
        action: 'start',
        engine: 'sensevoice-small',
        language: 'zh-CN',
      });
      f.service.cancel(f.owner);
      complete([{ id: 'sensevoice-small', source: 'downloaded' }]);
      expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
      expect(f.children).toHaveLength(0);
    } finally {
      f.service.dispose();
    }
  });
});
