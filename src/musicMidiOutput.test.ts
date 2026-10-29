import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { MusicAudio } from './musicAudio';
import { resolveMusicOutput, type MusicOutputEvent, type MusicOutputRequest } from './musicOutput';
import type { ScoreNote } from './musicScore';
const require = createRequire(import.meta.url);
const { createMidiTransport, validRequest } = require('../electron/music-midi-transport.cjs');
const { createMusicMidi } = require('../electron/music-midi.cjs');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const note = (midi: number, beat = 0, duration = 1, muted = false) => ({
  midi,
  beat,
  duration,
  muted,
});
const request = (extra = {}) => ({
  action: 'play',
  token: 'first',
  output: 'synth',
  program: 0,
  volume: 0.6,
  tempo: 60,
  beat: 0,
  duration: 4,
  notes: [note(60)],
  ...extra,
});
function transport() {
  const native = { open: vi.fn(), send: vi.fn(), close: vi.fn(), list: () => [] };
  const events = vi.fn();
  const t = createMidiTransport(native, events, () => Date.now());
  return { t, native, events };
}
it('schedules chords, muted notes and overlapping same pitches without early note-offs', () => {
  const { t, native, events } = transport();
  expect(
    t.run(request({ notes: [note(60, 0, 2), note(60, 1, 2), note(64), note(67, 0, 3, true)] })).ok,
  ).toBe(true);
  vi.advanceTimersByTime(60);
  expect(native.send.mock.calls.filter((c) => c[0] === 0x90)).toEqual([
    [0x90, 60, 90],
    [0x90, 64, 90],
  ]);
  vi.advanceTimersByTime(2000);
  expect(native.send.mock.calls.filter((c) => c[0] === 0x80)).toEqual([[0x80, 64, 0]]);
  vi.advanceTimersByTime(1000);
  expect(native.send).toHaveBeenCalledWith(0x80, 60, 0);
  vi.advanceTimersByTime(1000);
  expect(events).toHaveBeenCalledWith({ token: 'first', state: 'ended' });
  expect(vi.getTimerCount()).toBe(0);
  expect(native.close).toHaveBeenCalledTimes(2);
});
it('seeking resumes sustained notes and stale cancellation cannot stop a newer performance', () => {
  const { t, native } = transport();
  t.run(request({ beat: 1.5, notes: [note(60, 0, 3), note(62)] }));
  vi.advanceTimersByTime(60);
  expect(native.send).toHaveBeenCalledWith(0x90, 60, 90);
  expect(native.send).not.toHaveBeenCalledWith(0x90, 62, 90);
  t.run(request({ token: 'second', notes: [note(64)] }));
  t.run({ action: 'stop', token: 'first' });
  vi.advanceTimersByTime(60);
  expect(native.send).toHaveBeenCalledWith(0x90, 64, 90);
  t.run({ action: 'stop', token: 'second' });
  const sent = native.send.mock.calls.length;
  vi.advanceTimersByTime(6000);
  expect(native.send).toHaveBeenCalledTimes(sent);
  expect(vi.getTimerCount()).toBe(0);
});
it('skips expired notes after a stall without turning off a different held note of the same pitch', () => {
  const { t, native } = transport();
  t.run(request({ notes: [note(60, 0, 4), note(60, 1, 0.2)] }));
  vi.advanceTimersByTime(60);
  vi.setSystemTime(2060);
  vi.advanceTimersByTime(10);
  expect(native.send.mock.calls.filter((c) => c[0] === 0x80)).toEqual([]);
  t.dispose();
});
it('releases the port and reports asynchronous driver failures', () => {
  const { t, native, events } = transport();
  t.run(request());
  native.send.mockImplementation(() => {
    throw Error('disconnected');
  });
  vi.advanceTimersByTime(60);
  expect(events).toHaveBeenCalledWith({
    token: 'first',
    state: 'error',
    error: 'device-unavailable',
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(native.close).toHaveBeenCalledTimes(2);
});
it('rejects invalid or unbounded payloads without touching devices', () => {
  const { t, native } = transport();
  for (const patch of [
    { tempo: NaN },
    { tempo: 0 },
    { volume: 3 },
    { program: 128 },
    { notes: [note(128)] },
    { notes: [note(60, 3, 2)] },
    { notes: Array(200001).fill(note(60)) },
    { action: 'send', bytes: [0xf0, 0xf7] },
  ]) {
    expect(t.run(request(patch))).toEqual({ ok: false, error: 'invalid' });
  }
  expect(validRequest({ action: 'stop', token: {} })).toBe(false);
  expect(native.open).not.toHaveBeenCalled();
});
function mockBridge(defer = false) {
  let resolve: (value: any) => void = () => {};
  const listeners = new Set<(event: MusicOutputEvent) => void>();
  const run = vi.fn((r: MusicOutputRequest) =>
    r.action === 'play'
      ? defer
        ? new Promise<any>((r) => {
            resolve = r;
          })
        : Promise.resolve({ ok: true, startedAt: Date.now() + 60 })
      : Promise.resolve({ ok: true }),
  );
  vi.stubGlobal('window', {
    surfaceDesktop: {
      musicOutput: {
        run,
        onState: (fn: (event: MusicOutputEvent) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    },
  });
  const audio = new MusicAudio();
  audio.setOutput('synth');
  return { audio, run, listeners, resolve: (value: any) => resolve(value) };
}
it('cancels pending native startup and removes event subscriptions on dispose', async () => {
  const { audio, run, listeners, resolve } = mockBridge(true);
  const playing = audio.play([note(60) as ScoreNote], 0, 120, 0.6, 4, vi.fn(), vi.fn());
  const token = (run.mock.calls[0][0] as any).token;
  audio.dispose();
  resolve({ ok: true, startedAt: 60 });
  expect(await playing).toBe(false);
  expect(run).toHaveBeenCalledWith({ action: 'stop', token });
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('native device errors stop playback; volume and instrument changes reach the selected port', async () => {
  const { audio, run, listeners } = mockBridge();
  const failed = vi.fn();
  await audio.play([note(60) as ScoreNote], 0, 120, 0.6, 4, vi.fn(), vi.fn(), failed);
  audio.setInstrument(40);
  audio.setVolume(0.25);
  const token = (run.mock.calls[0][0] as any).token;
  expect(run).toHaveBeenCalledWith({ action: 'configure', token, program: 40, volume: 0.25 });
  for (const listener of listeners)
    listener({ token, state: 'error', error: 'device-unavailable' });
  expect(failed).toHaveBeenCalledWith('device-unavailable');
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  audio.dispose();
});
it('automatic output chooses a synthesizer and never sends to an arbitrary MIDI bridge', () => {
  const bridge = { id: 'bridge', name: 'TouchOSC Bridge', software: false };
  const synth = { id: 'synth', name: 'Microsoft GS Wavetable Synth', software: true };
  expect(resolveMusicOutput('auto', [bridge])).toBe('');
  expect(resolveMusicOutput('auto', [bridge, synth])).toBe('synth');
  expect(resolveMusicOutput('internal', [synth])).toBe('');
  expect(resolveMusicOutput('bridge', [bridge, synth])).toBe('bridge');
});
class FakeWorker extends EventEmitter {
  sent: any[] = [];
  postMessage(value: any) {
    this.sent.push(value);
    if (value.request.action === 'dispose') queueMicrotask(() => this.emit('exit', 0));
  }
  terminate = vi.fn();
}
it('bounds queued IPC and still stops on cancellation when the queue is saturated', async () => {
  const worker = new FakeWorker(),
    owner = {};
  const midi = createMusicMidi({ platform: 'win32', makeWorker: () => worker });
  const promises = [midi.run(owner, request())];
  for (let i = 0; i < 7; i++) promises.push(midi.run(owner, { action: 'list' }));
  expect(await midi.run(owner, { action: 'list' })).toEqual({ ok: false, error: 'busy' });
  expect(await midi.run(owner, { action: 'stop', token: 'first' })).toEqual({ ok: true });
  expect(worker.sent.at(-1).request.action).toBe('dispose');
  expect((await Promise.all(promises)).every((r) => !r.ok)).toBe(true);
  midi.dispose();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
it('idle MIDI enumeration releases its worker and driver crashes settle pending requests', async () => {
  const worker = new FakeWorker(),
    owner = {};
  const midi = createMusicMidi({ platform: 'win32', makeWorker: () => worker });
  const listing = midi.run(owner, { action: 'list' });
  worker.emit('message', { id: 1, result: { ok: true, devices: [] } });
  expect((await listing).ok).toBe(true);
  vi.advanceTimersByTime(30000);
  expect(worker.sent.at(-1).request.action).toBe('dispose');
  await Promise.resolve();
  const playing = midi.run(owner, request());
  worker.emit('error', Error('driver unavailable'));
  expect((await playing).ok).toBe(false);
  midi.dispose();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
