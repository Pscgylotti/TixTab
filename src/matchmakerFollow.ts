import type { ScoreNote } from './musicScore';
import type { FollowResult } from './musicFollow';
import { uid } from './model';
import { getModelIdleSeconds } from './modelIdle';
export interface MatchmakerBridge {
  run(request: {
    action: 'start' | 'stop' | 'seek' | 'audio' | 'idle-policy';
    token?: string;
    referenceKey?: string;
    idleReleaseSeconds?: number;
    epoch?: number;
    beat?: number;
    notes?: Pick<ScoreNote, 'midi' | 'beat' | 'duration' | 'muted'>[];
    tempo?: number;
    instrument?: number;
    method?: 'global' | 'oltw';
    samples?: Float32Array;
    time?: number;
  }): Promise<{
    ok: boolean;
    error?: string;
    logs?: string;
    cached?: boolean;
    data?: FollowResult & { epoch: number; level?: number; time?: number; latencyMs?: number };
  }>;
  onProgress(callback: (value: { token: string; progress: number }) => void): () => void;
}
export class MatchmakerFollow {
  private token = uid();
  private epoch = 0;
  private closed = false;
  private pending = false;
  private queue: { samples: Float32Array; time: number; epoch: number }[] = [];
  private off: (() => void) | undefined;
  constructor(
    private result: (
      data: NonNullable<Awaited<ReturnType<MatchmakerBridge['run']>>['data']>,
    ) => void,
    private failed: (error: string) => void,
  ) {}
  async start(
    notes: ScoreNote[],
    tempo: number,
    beat: number,
    instrument: number,
    progress: (value: number) => void,
    method: 'global' | 'oltw' = 'global',
  ) {
    const bridge = window.surfaceDesktop?.musicFollow;
    if (!bridge) throw Error('runtime-missing');
    if (!notes.length || notes.length > 100000) throw Error('score-limit');
    const reference = {
      notes: notes.map(({ midi, beat, duration, muted }) => ({
        midi,
        beat,
        duration,
        muted: !!muted,
      })),
      tempo,
      instrument,
      method,
    };
    // Content based, so in-place note edits and reopened players also invalidate
    // correctly. No extra score/audio history is retained by the renderer.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(reference)),
    );
    if (this.closed) return false;
    const referenceKey = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    this.off = bridge.onProgress((m) => {
      if (!this.closed && m.token === this.token) progress(m.progress);
    });
    const request = {
      action: 'start' as const,
      token: this.token,
      referenceKey,
      tempo,
      beat,
      instrument,
      method,
      epoch: this.epoch,
      idleReleaseSeconds: getModelIdleSeconds(),
    };
    // The main process is authoritative: cache eviction/crashes are ordinary
    // misses and require one upload, never a stale-score fallback.
    let r: Awaited<ReturnType<MatchmakerBridge['run']>>;
    try {
      r = await bridge.run(request);
      if (!this.closed && !r.ok && r.error === 'reference-missing')
        r = await bridge.run({ ...request, notes: reference.notes });
    } finally {
      this.off?.();
      this.off = undefined;
    }
    if (this.closed) {
      void bridge.run({ action: 'stop', token: this.token }).catch(() => {});
      return false;
    }
    if (!r.ok) throw Error(r.error || 'follow-failed');
    return true;
  }
  seek(beat: number) {
    if (this.closed) return;
    this.queue = [];
    const epoch = ++this.epoch;
    void window.surfaceDesktop?.musicFollow
      ?.run({ action: 'seek', token: this.token, beat, epoch })
      .then((r) => {
        if (!this.closed && !r.ok) this.failed(r.error || 'follow-failed');
      })
      .catch(() => {
        if (!this.closed) this.failed('follow-failed');
      });
  }
  audio(samples: Float32Array, time: number) {
    if (this.closed) return;
    // Back-pressure is bounded to 160 ms; old audio must never form a growing delay.
    if (this.queue.length >= 4) this.queue.shift();
    this.queue.push({ samples, time, epoch: this.epoch });
    void this.pump();
  }
  private async pump() {
    if (this.pending || this.closed) return;
    this.pending = true;
    try {
      while (!this.closed && this.queue.length) {
        const frame = this.queue.shift()!;
        const r = await window.surfaceDesktop!.musicFollow!.run({
          action: 'audio',
          token: this.token,
          ...frame,
        });
        if (this.closed) break;
        if (!r.ok) {
          this.failed(r.error || 'follow-failed');
          break;
        }
        if (r.data?.epoch === this.epoch) this.result(r.data);
      }
    } catch {
      if (!this.closed) this.failed('follow-failed');
    } finally {
      this.pending = false;
    }
  }
  stop() {
    this.closed = true;
    this.queue = [];
    this.off?.();
    this.off = undefined;
    void window.surfaceDesktop?.musicFollow
      ?.run({ action: 'stop', token: this.token })
      .catch(() => {});
  }
}
