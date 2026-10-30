import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { crc32 } from 'node:zlib';

const { createMusicFollow } = createRequire(import.meta.url)('../electron/music-follow.cjs');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function archive() {
  const name = Buffer.from('libfluidsynth-3.dll'),
    data = Buffer.from('test DLL');
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

const reference = {
  notes: [{ midi: 60, beat: 0, duration: 1, muted: false }],
  tempo: 120,
  instrument: 0,
  method: 'global',
};
it('attenuates loud packets and removes invalid samples without disconnecting the live session', async () => {
  const { f, owner, children } = await fixture(),
    w = owner();
  await f.run(w, request('loud', reference, true));
  const packet = { action: 'audio', token: 'loud', epoch: 0, time: 1 };
  const input = new Float32Array(640);
  input.set([40, -20, NaN, Infinity, -Infinity]);
  expect((await f.run(w, { ...packet, samples: input })).ok).toBe(true);
  const sent = children[0].requests.at(-1);
  const pcm = Buffer.from(sent.pcm, 'base64');
  expect(Array.from({ length: 5 }, (_, i) => pcm.readFloatLE(i * 4))).toEqual([4, -2, 0, 0, 0]);
  const quiet = new Float32Array(320).fill(0.001);
  expect((await f.run(w, { ...packet, time: 2, samples: quiet })).ok).toBe(true);
  expect(Buffer.from(children[0].requests.at(-1).pcm, 'base64')).toEqual(Buffer.from(quiet.buffer));
  expect((await f.run(w, { ...packet, time: 3, samples: new Float32Array(20) })).error).toBe(
    'invalid',
  );
  expect(children[0].stdin.end).not.toHaveBeenCalled();
});
function request(token: string, payload = reference, upload = false) {
  return {
    action: 'start',
    token,
    referenceKey: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    ...payload,
    notes: upload ? payload.notes : undefined,
    beat: 0,
    epoch: 0,
    idleReleaseSeconds: 1800,
  };
}

async function fixture(referenceBytes = 4096) {
  const root = await mkdtemp(join(tmpdir(), 'tixtab-follow-cache-'));
  await mkdir(join(root, 'homr-runtime', 'Scripts'), { recursive: true });
  await writeFile(join(root, 'homr-runtime', 'Scripts', 'python.exe'), 'test executable');
  await writeFile(join(root, 'matchmaker_runner.py'), 'test runner');
  await writeFile(join(root, 'fluidsynth.zip'), archive());
  await writeFile(join(root, 'GeneralUser-GS.sf2'), 'test bank');
  const children: any[] = [],
    owners: object[] = [];
  const spawnProcess = vi.fn(() => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.requests = [];
    const finish = () => {
      child.exitCode = 0;
      child.stdin.writable = false;
      queueMicrotask(() => child.emit('close', 0));
    };
    child.stdin = {
      writable: true,
      write: (line: string, callback: () => void) => {
        const r = JSON.parse(line);
        child.requests.push(r);
        queueMicrotask(() => {
          callback();
          child.stdout.emit(
            'data',
            JSON.stringify({ id: r.id, ok: true, data: { epoch: r.epoch } }) + '\n',
          );
        });
      },
      end: vi.fn(finish),
    };
    child.kill = vi.fn(finish);
    children.push(child);
    setImmediate(() =>
      child.stdout.emit('data', JSON.stringify({ event: 'ready', referenceBytes }) + '\n'),
    );
    return child;
  });
  const resolveModel = vi.fn(async (key: string) => join(root, basename(key)));
  const f = createMusicFollow({ root, backend: root, spawnProcess, resolveModel });
  cleanups.push(async () => {
    for (const owner of owners) await f.cancel(owner);
    f.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    f,
    root,
    children,
    spawnProcess,
    resolveModel,
    owner: () => {
      const owner = {};
      owners.push(owner);
      return owner;
    },
  };
}

it('uploads once, parks without accepting PCM, then reuses the worker at a new position and epoch', async () => {
  const { f, owner, children, spawnProcess, resolveModel, root } = await fixture();
  const w = owner();
  expect(await f.run(w, request('one'))).toEqual({ ok: false, error: 'reference-missing' });
  expect(await f.run(w, request('one', reference, true))).toEqual({ ok: true, cached: false });
  await f.run(w, { action: 'stop', token: 'one' });
  expect(children[0].requests.at(-1).action).toBe('suspend');
  const audio = {
    action: 'audio',
    token: 'one',
    epoch: 0,
    time: 0.04,
    samples: new Float32Array(640),
  };
  expect(await f.run(w, audio)).toEqual({ ok: false, error: 'cancelled' });
  expect(children[0].stdin.end).not.toHaveBeenCalled();
  expect(await f.run(w, { ...request('two'), beat: 8, epoch: 2 })).toEqual({
    ok: true,
    cached: true,
  });
  expect(children[0].requests.at(-1)).toMatchObject({ action: 'restart', beat: 8, epoch: 2 });
  await f.run(w, { action: 'stop', token: 'one' }); // Late cleanup from the previous player.
  expect((await f.run(w, { ...audio, token: 'two', epoch: 2 })).ok).toBe(true);
  expect(await f.run(owner(), { ...audio, token: 'two' })).toEqual({
    ok: false,
    error: 'cancelled',
  });
  expect(spawnProcess).toHaveBeenCalledTimes(1);
  expect(resolveModel).toHaveBeenCalledTimes(2);
  await f.cancel(w);
  expect(children[0].stdin.end).toHaveBeenCalledTimes(1);
  expect((await readdir(root)).filter((name) => name.startsWith('music-follow-'))).toEqual([]);
});

it('changed MIDI, tempo, instrument, method and backend files require a fresh reference', async () => {
  const { f, owner, root, spawnProcess } = await fixture();
  const w = owner();
  let index = 0;
  for (const payload of [
    reference,
    { ...reference, notes: [{ ...reference.notes[0], midi: 64 }] },
    { ...reference, tempo: 90 },
    { ...reference, instrument: 3 },
    { ...reference, method: 'oltw' },
  ]) {
    const token = String(index++);
    expect((await f.run(w, request(token, payload))).error).toBe('reference-missing');
    expect(await f.run(w, request(token, payload, true))).toEqual({ ok: true, cached: false });
    await f.run(w, { action: 'stop', token });
  }
  await writeFile(join(root, 'matchmaker_runner.py'), 'updated runner, new reference format');
  const last = { ...reference, method: 'oltw' };
  expect((await f.run(w, request('updated', last))).error).toBe('reference-missing');
  expect(await f.run(w, request('updated', last, true))).toEqual({ ok: true, cached: false });
  expect(spawnProcess).toHaveBeenCalledTimes(6);
});

it('idle policy changes use original stop time, repeated stops cannot keep a cache alive', async () => {
  const { f, owner, children } = await fixture();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const w = owner();
  await f.run(w, request('one', reference, true));
  await f.run(w, { action: 'stop', token: 'one' });
  await vi.advanceTimersByTimeAsync(20000);
  await f.run(w, { action: 'stop', token: 'one' });
  await f.run(w, { action: 'idle-policy', idleReleaseSeconds: 30 });
  await vi.advanceTimersByTimeAsync(9999);
  expect(children[0].stdin.end).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(children[0].stdin.end).toHaveBeenCalledTimes(1);
  expect((await f.run(w, request('two'))).error).toBe('reference-missing');
});

it('oversized references are released on stop and only one idle reference is retained across owners', async () => {
  const large = await fixture(65 * 1024 * 1024),
    w = large.owner();
  await large.f.run(w, request('one', reference, true));
  await large.f.run(w, { action: 'stop', token: 'one' });
  expect(large.children[0].stdin.end).toHaveBeenCalledTimes(1);
  expect((await large.f.run(w, request('two'))).error).toBe('reference-missing');
  const small = await fixture(),
    first = small.owner(),
    second = small.owner();
  await small.f.run(first, request('first', reference, true));
  await small.f.run(first, { action: 'stop', token: 'first' });
  await small.f.run(second, request('second', reference, true));
  await small.f.run(second, { action: 'stop', token: 'second' });
  expect((await small.f.run(first, request('first-again'))).error).toBe('reference-missing');
  expect(await small.f.run(second, request('second-again'))).toEqual({ ok: true, cached: true });
});

it('restart racing a stop keeps the new session active and ignores delayed old process events', async () => {
  const { f, owner, children } = await fixture(),
    w = owner();
  await f.run(w, request('one', reference, true));
  const stopping = f.run(w, { action: 'stop', token: 'one' });
  const restart = f.run(w, request('two'));
  await stopping;
  expect(await restart).toEqual({ ok: true, cached: true });
  const newer = { ...reference, tempo: 100 };
  await f.run(w, request('three', newer, true));
  children[0].emit('close', 0);
  children[0].stdout.emit('data', JSON.stringify({ event: 'ready', referenceBytes: 4096 }) + '\n');
  expect((await f.run(w, { action: 'seek', token: 'three', beat: 3, epoch: 1 })).ok).toBe(true);
});

it('preserves response timeout details instead of overwriting them with cancellation', async () => {
  const { f, owner, children, root } = await fixture(),
    w = owner();
  await f.run(w, request('one', reference, true));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  children[0].stdin.write = (_line: string, done: () => void) => done();
  const response = f.run(w, { action: 'seek', token: 'one', beat: 3, epoch: 1 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await response).toMatchObject({
    ok: false,
    error: 'timeout',
    logs: expect.stringContaining('seek'),
  });
  expect(children[0].stdin.end).toHaveBeenCalledTimes(1);
  await vi.waitFor(async () =>
    expect((await readdir(root)).filter((name) => name.startsWith('music-follow-'))).toEqual([]),
  );
});

it('returns worker errors and crash diagnostics to the active caller', async () => {
  const { f, owner, children, root } = await fixture(),
    w = owner();
  await f.run(w, request('one', reference, true));
  children[0].stdin.write = (line: string, done: () => void) => {
    done();
    const { id } = JSON.parse(line);
    // stderr and stdout are independent streams; the error response itself
    // carries diagnostics even if stderr arrives later.
    children[0].stdout.emit(
      'data',
      JSON.stringify({ id, ok: false, error: 'follow-failed', logs: 'ValueError: invalid state' }) +
        '\n',
    );
  };
  expect(await f.run(w, { action: 'seek', token: 'one', beat: 3, epoch: 1 })).toMatchObject({
    ok: false,
    error: 'follow-failed',
    logs: 'ValueError: invalid state',
  });
  children[0].stdin.write = (_line: string, done: () => void) => done();
  const response = f.run(w, { action: 'seek', token: 'one', beat: 4, epoch: 2 });
  children[0].stderr.emit('data', 'RuntimeError: worker crashed');
  children[0].exitCode = 1;
  children[0].emit('close', 1);
  expect(await response).toMatchObject({
    ok: false,
    error: 'worker-exited',
    logs: expect.stringContaining('RuntimeError: worker crashed'),
  });
  await vi.waitFor(async () =>
    expect((await readdir(root)).filter((name) => name.startsWith('music-follow-'))).toEqual([]),
  );
});

it('keeps a crash between packets available only to its own session, then clears it on stop', async () => {
  const { f, owner, children, root } = await fixture(),
    w = owner();
  await f.run(w, request('one', reference, true));
  children[0].stderr.emit('data', 'RuntimeError: crash between packets');
  children[0].exitCode = 1;
  children[0].emit('close', 1);
  const next = { action: 'audio', token: 'one', samples: new Float32Array(640), time: 1, epoch: 0 };
  expect(await f.run(w, next)).toMatchObject({
    error: 'worker-exited',
    logs: expect.stringContaining('crash between packets'),
  });
  expect(await f.run(owner(), next)).toEqual({ ok: false, error: 'cancelled' });
  expect(await f.run(w, { ...next, token: 'another' })).toEqual({ ok: false, error: 'cancelled' });
  await f.run(w, { action: 'stop', token: 'one' });
  expect(await f.run(w, next)).toEqual({ ok: false, error: 'cancelled' });
  await vi.waitFor(async () =>
    expect((await readdir(root)).filter((name) => name.startsWith('music-follow-'))).toEqual([]),
  );
});
