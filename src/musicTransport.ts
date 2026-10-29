import { useSyncExternalStore } from 'react';
import type { Page } from './model';
import type { ScoreNote, MusicScore } from './musicScore';
export interface TimedScore {
  pageId: string;
  index: number;
  start: number;
  score: MusicScore;
}
export function scoreTimeline(pages: Page[]) {
  let start = 0;
  return pages.flatMap((p, index) => {
    if (!p.score) return [];
    const item = { pageId: p.id, index, start, score: p.score };
    start += p.score.duration;
    return [item];
  });
}
export function scoreAt(timeline: TimedScore[], beat: number) {
  for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].start <= beat) return timeline[i];
  return timeline[0];
}
/** Keep the sounding page inside the current spread, anchored to its actual left page. */
export function scoreViewportIndex(
  mode: 'single' | 'continuous' | 'dual',
  left: number,
  target: number,
) {
  return mode === 'dual' ? Math.max(0, left + 2 * Math.floor((target - left) / 2)) : target;
}
export function timelineNotes(timeline: TimedScore[]) {
  return timeline
    .flatMap((p) =>
      p.score.notes.filter((n) => !n.muted).map((n) => ({ ...n, beat: n.beat + p.start })),
    )
    .sort((a, b) => a.beat - b.beat);
}
/** Printed continuation anchors retain tied-note locations without retriggering audio. */
export function scoreAnchors(score: MusicScore): ScoreNote[] {
  return score.notes
    .flatMap((n) => [
      n,
      ...(n.continuations ?? []).map((c) => ({ ...n, ...c, continuations: undefined })),
    ])
    .sort((a, b) => a.beat - b.beat || a.system - b.system || a.region.x - b.region.x);
}
export function cursorNote(
  score: MusicScore,
  beat: number,
  anchors = scoreAnchors(score),
): ScoreNote | undefined {
  let result: ScoreNote | undefined;
  for (const n of anchors) {
    if (n.beat > beat + 0.001) break;
    // A chord shares one onset; consistently use its first (upper/left) anchor.
    if (!n.muted && (!result || n.beat > result.beat + 0.001)) result = n;
  }
  return result;
}
interface Cursor {
  pageId: string;
  beat: number;
  selectedId?: string;
  seek: ((pageId: string, beat: number, noteId: string) => void) | null;
}
let inactive: Cursor = { pageId: '', beat: 0, seek: null };
let cursor: Cursor = inactive;
const listeners = new Set<() => void>();
export function setScoreCursor(value: Cursor) {
  if (inactive.seek !== value.seek) inactive = { pageId: '', beat: 0, seek: value.seek };
  cursor = value;
  listeners.forEach((f) => f());
}
export function useScoreCursor(pageId?: string) {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    () => (!pageId || pageId === cursor.pageId ? cursor : inactive),
  );
}
export function estimateMidi(samples: Float32Array, sampleRate: number): number | null {
  let energy = 0;
  for (const x of samples) energy += x * x;
  if (Math.sqrt(energy / samples.length) < 0.01) return null;
  const low = Math.floor(sampleRate / 1200),
    high = Math.min(Math.floor(sampleRate / 70), samples.length / 2);
  let best = 0,
    bestLag = 0;
  const correlations: number[] = [];
  for (let lag = low; lag <= high; lag++) {
    let sum = 0,
      a = 0,
      b = 0;
    for (let i = 0; i < samples.length - lag; i += 2) {
      sum += samples[i] * samples[i + lag];
      a += samples[i] ** 2;
      b += samples[i + lag] ** 2;
    }
    const corr = sum / Math.sqrt(a * b || 1);
    correlations[lag] = corr;
    if (corr > best) {
      best = corr;
      bestLag = lag;
    }
  }
  if (best < 0.85) return null;
  for (let lag = low + 1; lag < bestLag; lag++)
    if (
      correlations[lag] > 0.9 * best &&
      correlations[lag] > correlations[lag - 1] &&
      correlations[lag] >= correlations[lag + 1]
    ) {
      bestLag = lag;
      break;
    }
  return Math.round(69 + 12 * Math.log2(sampleRate / bestLag / 440));
}
export function followScore(notes: ScoreNote[], beat: number, midi: number) {
  const at = Math.max(
    0,
    notes.findIndex((n) => n.beat >= beat - 0.001),
  );
  return notes
    .slice(at, at + 24)
    .filter((n) => n.beat >= beat - 0.001 && (n.midi === midi || n.midi % 12 === midi % 12))
    .sort(
      (a, b) =>
        a.beat - beat + (a.midi === midi ? 0 : 2) - (b.beat - beat + (b.midi === midi ? 0 : 2)),
    )[0];
}
