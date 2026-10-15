import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withNativeCppOcr } from './nativeCppOcr';
const { createNativeOcr } = createRequire(import.meta.url)('../electron/native-ocr.cjs');
afterEach(() => vi.unstubAllGlobals());
const png = (width = 100, height = 50) => {
  const b = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return 'data:image/png;base64,' + b.toString('base64');
};
it('native owner reuses a process, bounds concurrency and terminates active work before deleting temporary models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tixtab-native-test-')),
    model = join(root, 'source'),
    owner = new EventEmitter(),
    children: any[] = [];
  await writeFile(model, 'test weights');
  let delay = 10;
  const service = createNativeOcr({
    executable: process.execPath,
    workingRoot: join(root, 'jobs'),
    resolveModel: async () => model,
    spawn: (_exe: any, _args: any, options: any) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
      process.stdout.write(JSON.stringify({ready:true})+'\\n');
      let bytes=Buffer.alloc(0);
      process.stdin.on('data',chunk=>{
        bytes=Buffer.concat([bytes,chunk]);
        if(bytes.length<4||bytes.length<4+bytes.readUInt32LE(0))return;
        const data=bytes.subarray(4);bytes=Buffer.alloc(0);
        setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,text:'word gap',lines:[],width:data.readUInt32BE(16),height:data.readUInt32BE(20)})+'\\n'),${delay});
      });
    `,
        ],
        options,
      );
      children.push(child);
      return child;
    },
  });
  try {
    expect(
      (await service.run(owner, { action: 'open', id: 'one', variant: 'fast', count: 2 })).ok,
    ).toBe(true);
    expect(
      (await service.run(owner, { action: 'recognize', id: 'one', image: png() })).data.text,
    ).toBe('word gap');
    expect((await service.run(owner, { action: 'recognize', id: 'one', image: png() })).ok).toBe(
      true,
    );
    expect(children).toHaveLength(1);
    expect(
      (await service.run(owner, { action: 'recognize', id: 'one', image: png(4000, 4000) })).error,
    ).toBe('image-limit');
    expect((await service.run(owner, { action: 'close', id: 'other' })).ok).toBe(true);
    expect(children[0].exitCode).toBeNull();
    expect((await service.run(owner, { action: 'close', id: 'one' })).ok).toBe(true);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
    expect(await readdir(join(root, 'jobs'))).toEqual([]);
    delay = 300000;
    await service.run(owner, { action: 'open', id: 'two', variant: 'mixed-fast', count: 2 });
    const first = service.run(owner, { action: 'recognize', id: 'two', image: png() }),
      second = service.run(owner, { action: 'recognize', id: 'two', image: png() });
    expect((await service.run(owner, { action: 'recognize', id: 'two', image: png() })).error).toBe(
      'native-ocr-busy',
    );
    await service.run(owner, { action: 'close', id: 'two' });
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
    expect(await readdir(join(root, 'jobs'))).toEqual([]);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('failed preparation and destroyed owners leave no model copies or child processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tixtab-native-missing-')),
    owner = new EventEmitter();
  let release: () => void = () => {};
  const service = createNativeOcr({
    executable: process.execPath,
    workingRoot: root,
    resolveModel: () =>
      new Promise((resolve) => {
        release = () => resolve(null);
      }),
  });
  try {
    const pending = service.run(owner, {
      action: 'open',
      id: 'missing',
      variant: 'fast',
      count: 1,
    });
    await vi.waitFor(() => expect(owner.listenerCount('destroyed')).toBe(1));
    owner.emit('destroyed');
    release();
    expect((await pending).ok).toBe(false);
    await service.dispose();
    expect(await readdir(root)).toEqual([]);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('renderer budget serializes large images, retains words/timing and always closes its native session', async () => {
  let active = 0,
    peak = 0;
  const run = vi.fn(async (request: any) => {
    if (request.action !== 'recognize') return { ok: true };
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return {
      ok: true,
      data: {
        text: 'word gap',
        engine: 'Tesseract C++',
        lines: [
          {
            text: 'word gap',
            polygon: [0, 0, 10, 0, 10, 5, 0, 5],
            words: [{ text: 'word', polygon: [0, 0, 4, 0, 4, 5, 0, 5] }],
          },
        ],
        timing: { inferenceMs: 3 },
      },
    };
  });
  vi.stubGlobal('window', { surfaceDesktop: { nativeOcr: { run } } });
  const results = await withNativeCppOcr('fast', 4, new AbortController().signal, (recognize) =>
    Promise.all([recognize(png(2000, 2000), 0), recognize(png(2000, 2000), 1)]),
  );
  expect(peak).toBe(1);
  expect(results[0].lines?.[0].words?.[0].text).toBe('word');
  expect(results[0].timing?.inferenceMs).toBe(3);
  expect(run.mock.calls.at(-1)?.[0].action).toBe('close');
});
it('renderer cancellation closes and drains outstanding recognition instead of abandoning its process', async () => {
  const abort = new AbortController();
  let rejectJob: (error: Error) => void = () => {};
  const run = vi.fn(async (request: any) => {
    if (request.action === 'recognize')
      return new Promise((_resolve, reject) => {
        rejectJob = reject;
      });
    if (request.action === 'close') rejectJob(Error('cancelled'));
    return { ok: true };
  });
  vi.stubGlobal('window', { surfaceDesktop: { nativeOcr: { run } } });
  const pending = withNativeCppOcr('fast', 1, abort.signal, (recognize) => recognize(png(), 0));
  const settled = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(run.mock.calls.some(([r]) => r.action === 'recognize')).toBe(true));
  abort.abort();
  await settled;
  expect(run.mock.calls.at(-1)?.[0].action).toBe('close');
});
