import { afterEach, expect, it, vi } from 'vitest';
import { MatchmakerFollow } from './matchmakerFollow';
import type { ScoreNote } from './musicScore';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createMusicFollow } = createRequire(import.meta.url)('../electron/music-follow.cjs');
afterEach(() => vi.unstubAllGlobals());
const notes = [{ midi: 60, beat: 0, duration: 1 }] as ScoreNote[];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function bridge() {
  const calls: any[] = [],
    audio: ((r: any) => void)[] = [],
    off = vi.fn();
  const b = {
    onProgress: () => off,
    run: vi.fn((request: any) => {
      calls.push(request);
      if (request.action === 'audio') return new Promise((resolve) => audio.push(resolve));
      return Promise.resolve({ ok: true });
    }),
  };
  vi.stubGlobal('window', { surfaceDesktop: { musicFollow: b } });
  return { calls, audio, off, b };
}
it('bounds queued PCM, drops old frames and ignores results after stop', async () => {
  const { calls, audio } = bridge(),
    result = vi.fn(),
    failed = vi.fn();
  const f = new MatchmakerFollow(result, failed);
  await f.start(notes, 120, 0, 0, () => {});
  expect(calls[0].method).toBe('global');
  for (let i = 0; i < 30; i++) f.audio(new Float32Array(640), i * 0.04);
  expect(calls.filter((c) => c.action === 'audio')).toHaveLength(1);
  for (let i = 0; i < 5; i++) {
    audio.shift()!({ ok: true, data: { state: 'matched', beat: i, epoch: 0 } });
    await settle();
  }
  expect(calls.filter((c) => c.action === 'audio').map((c) => c.time)).toEqual([
    0,
    26 * 0.04,
    27 * 0.04,
    28 * 0.04,
    29 * 0.04,
  ]);
  expect(result).toHaveBeenCalledTimes(5);
  f.audio(new Float32Array(640), 2);
  f.stop();
  audio.shift()!({ ok: true, data: { state: 'matched', beat: 99, epoch: 0 } });
  await settle();
  expect(result).toHaveBeenCalledTimes(5);
  expect(failed).not.toHaveBeenCalled();
});
it('seeking discards queued audio and ignores the prior position response', async () => {
  const { calls, audio } = bridge(),
    result = vi.fn();
  const f = new MatchmakerFollow(result, vi.fn());
  await f.start(notes, 120, 0, 0, () => {});
  f.audio(new Float32Array(640), 0.04);
  f.audio(new Float32Array(640), 0.08);
  f.seek(4);
  f.audio(new Float32Array(640), 0.12);
  audio.shift()!({ ok: true, data: { state: 'matched', beat: 1, epoch: 0 } });
  await settle();
  expect(result).not.toHaveBeenCalled();
  expect(calls.filter((c) => c.action === 'audio').map((c) => c.epoch)).toEqual([0, 1]);
  audio.shift()!({ ok: true, data: { state: 'matched', beat: 4, epoch: 1 } });
  await settle();
  expect(result).toHaveBeenCalledWith(expect.objectContaining({ beat: 4 }));
  f.stop();
});
it('stopping during startup removes progress subscriptions and cannot restart capture', async () => {
  const { b, off } = bridge();
  let ready!: (r: any) => void;
  b.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const f = new MatchmakerFollow(vi.fn(), vi.fn());
  const start = f.start(notes, 120, 0, 0, () => {});
  await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
  f.stop();
  ready({ ok: true });
  expect(await start).toBe(false);
  expect(off).toHaveBeenCalledTimes(1);
  expect(b.run.mock.calls.filter((c) => c[0].action === 'stop').length).toBeGreaterThan(0);
});
it('main-process cancellation during model lookup prevents spawning and another owner cannot send audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tixtab-follow-test-'));
  try {
    await mkdir(join(root, 'homr-runtime', 'Scripts'), { recursive: true });
    await writeFile(join(root, 'homr-runtime', 'Scripts', 'python.exe'), '');
    const ready: ((s: string) => void)[] = [],
      spawn = vi.fn(),
      owner = {};
    const f = createMusicFollow({
      root,
      backend: root,
      spawnProcess: spawn,
      resolveModel: () => new Promise((resolve) => ready.push(resolve)),
    });
    const pending = f.run(owner, {
      action: 'start',
      token: 'a',
      notes,
      tempo: 120,
      beat: 0,
      epoch: 0,
    });
    await settle();
    expect(ready).toHaveLength(2);
    expect(
      await f.run(
        {},
        { action: 'audio', token: 'a', samples: new Float32Array(640), time: 0, epoch: 0 },
      ),
    ).toEqual({ ok: false, error: 'cancelled' });
    await f.run(owner, { action: 'stop', token: 'a' });
    ready.forEach((r) => r('unused'));
    expect(await pending).toEqual({ ok: false, error: 'cancelled' });
    expect(spawn).not.toHaveBeenCalled();
    f.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('probes by content key, uploads on a miss, and invalidates for edits but not position changes', async () => {
  const { b, calls } = bridge();
  let cached: string | undefined;
  b.run.mockImplementation(async (r) => {
    calls.push(r);
    if (r.action !== 'start') return { ok: true };
    if (r.notes) cached = r.referenceKey;
    return cached === r.referenceKey ? { ok: true } : { ok: false, error: 'reference-missing' };
  });
  const score = notes.map((n) => ({ ...n }));
  async function start(
    beat: number,
    tempo = 120,
    instrument = 0,
    method: 'global' | 'oltw' = 'global',
  ) {
    const f = new MatchmakerFollow(vi.fn(), vi.fn());
    await f.start(score, tempo, beat, instrument, () => {}, method);
    f.stop();
  }
  await start(0);
  const firstKey = cached;
  await start(4);
  expect(cached).toBe(firstKey);
  expect(calls.filter((r) => r.notes)).toHaveLength(1);
  expect(calls.filter((r) => r.action === 'start').at(-1)).toMatchObject({
    beat: 4,
    referenceKey: firstKey,
  });
  score[0].midi = 62;
  await start(4);
  score[0].duration = 2;
  await start(4);
  score[0].muted = true;
  await start(4);
  await start(4, 90);
  await start(4, 90, 3);
  await start(4, 90, 3, 'oltw');
  expect(calls.filter((r) => r.notes)).toHaveLength(7);
});

it('does not upload after a cancelled cache probe and releases progress callbacks on transport errors', async () => {
  const { b, off } = bridge();
  let resolve!: (r: any) => void;
  b.run.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const f = new MatchmakerFollow(vi.fn(), vi.fn());
  const pending = f.start(notes, 120, 0, 0, vi.fn());
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  f.stop();
  resolve({ ok: false, error: 'reference-missing' });
  expect(await pending).toBe(false);
  expect(b.run.mock.calls.every(([r]) => !r.notes)).toBe(true);
  expect(off).toHaveBeenCalledTimes(1);
  b.run.mockRejectedValueOnce(Error('IPC disconnected'));
  const next = new MatchmakerFollow(vi.fn(), vi.fn());
  await expect(next.start(notes, 120, 0, 0, vi.fn())).rejects.toThrow('IPC disconnected');
  expect(off).toHaveBeenCalledTimes(2);
  next.stop();
});
