import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { createDictation } = createRequire(import.meta.url)('../electron/dictation.cjs');
describe('owned offline dictation', () => {
  it('lists input identities without recording, passes explicit selection, and reports a missing device', async () => {
    const children: any[] = [];
    const service = createDictation({
      helper: 'test',
      platform: 'win32',
      spawnProcess: (_exe: string, args: string[]) => {
        const child: any = new EventEmitter();
        child.stdout = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => {};
        child.args = args;
        children.push(child);
        return child;
      },
    });
    const owner = {};
    try {
      const listing = service.run(owner, { action: 'microphones' });
      expect(children[0].args).toContain('-Microphones');
      const pending = service.run(owner, { action: 'microphones' });
      children[0].stdout.end(
        JSON.stringify({
          microphones: [{ id: 'winmm:YWJj', name: 'Surface 麦克风', isDefault: true }],
          defaultId: 'winmm:YWJj',
        }),
      );
      children[0].emit('close', 0);
      expect((await listing).data.microphones[0].name).toBe('Surface 麦克风');
      expect((await pending).data.defaultId).toBe('winmm:YWJj');
      expect(children).toHaveLength(1);
      expect(
        (await service.run(owner, { action: 'start', language: 'en-US', microphone: ';bad' }))
          .error,
      ).toBe('invalid');
      const start = await service.run(owner, {
        action: 'start',
        language: 'en-US',
        microphone: 'winmm:YWJj',
      });
      expect(children[1].args.slice(-2)).toEqual(['-Microphone', 'winmm:YWJj']);
      children[1].stdout.write(
        'INPUT ' +
          Buffer.from('Surface 麦克风').toString('base64') +
          '\nERROR microphone-missing\n',
      );
      children[1].emit('close', 0);
      expect((await service.run(owner, { action: 'read', id: start.data.id })).data).toMatchObject({
        microphoneName: 'Surface 麦克风',
        error: 'microphone-missing',
        done: true,
      });
    } finally {
      service.dispose();
    }
  });
  it('starts only on demand, restricts language, decodes chunked Unicode and stops the owned helper', async () => {
    let spawned = 0,
      killed = 0,
      launchOptions: any;
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      killed++;
      child.emit('close');
    };
    const service = createDictation({
        helper: 'C:/test/dictation.ps1',
        platform: 'win32',
        spawnProcess: (_exe: string, _args: string[], options: any) => {
          spawned++;
          launchOptions = options;
          return child;
        },
      }),
      owner = { id: 1 };
    try {
      expect(spawned).toBe(0);
      expect((await service.run(owner, { action: 'start', language: 'bad;command' })).ok).toBe(
        false,
      );
      const start = await service.run(owner, { action: 'start', language: 'zh-CN' });
      expect(start.ok).toBe(true);
      expect(spawned).toBe(1);
      expect(launchOptions.windowsHide).toBe(true);
      expect((await service.run({ id: 2 }, { action: 'read', id: start.data.id })).ok).toBe(false);
      child.stdout.write('REA');
      child.stdout.write(
        'DY\nLEVEL 67\nTEXT ' + Buffer.from('公式与论文').toString('base64') + '\n',
      );
      const read = await service.run(owner, { action: 'read', id: start.data.id });
      expect(read.data.text).toBe('公式与论文');
      expect(read.data.ready).toBe(true);
      expect(read.data.level).toBe(67);
      service.cancel({ id: 2 });
      expect(child.stdin.read()).toBeNull();
      service.cancel(owner);
      expect(child.stdin.read().toString()).toBe('\n');
    } finally {
      service.dispose();
    }
    expect(killed).toBe(1);
  });
  it('reports missing recognition language and never returns raw process errors', async () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const service = createDictation({
        helper: 'test',
        platform: 'win32',
        spawnProcess: () => child,
      }),
      owner = {};
    try {
      const job = await service.run(owner, { action: 'start', language: 'en-US' });
      child.stdout.write('ERROR language\n');
      child.emit('close');
      expect((await service.run(owner, { action: 'read', id: job.data.id })).data).toMatchObject({
        done: true,
        error: 'language',
      });
    } finally {
      service.dispose();
    }
  });
});
