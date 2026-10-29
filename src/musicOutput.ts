import type { ScoreNote } from './musicScore';
export interface MusicOutputDevice {
  id: string;
  name: string;
  software: boolean;
}
export interface MusicOutputEvent {
  token: string;
  state: 'ended' | 'error';
  error?: string;
}
export type MusicOutputRequest =
  | { action: 'list' }
  | { action: 'stop'; token: string }
  | { action: 'configure'; token: string; program: number; volume: number }
  | {
      action: 'play';
      token: string;
      output: string;
      program: number;
      volume: number;
      notes: Pick<ScoreNote, 'midi' | 'beat' | 'duration' | 'muted'>[];
      beat: number;
      tempo: number;
      duration: number;
    };
export interface MusicOutputBridge {
  run: (
    request: MusicOutputRequest,
  ) => Promise<{ ok: boolean; error?: string; devices?: MusicOutputDevice[]; startedAt?: number }>;
  onState: (callback: (event: MusicOutputEvent) => void) => () => void;
}
export function savedMusicOutput() {
  try {
    return localStorage.getItem('tixtab.musicOutput') || 'auto';
  } catch {
    return 'auto';
  }
}
export function saveMusicOutput(value: string) {
  try {
    localStorage.setItem('tixtab.musicOutput', value);
  } catch {
    /* Storage can be unavailable. */
  }
}
export function resolveMusicOutput(value: string, devices: MusicOutputDevice[]) {
  if (value === 'internal') return '';
  if (value !== 'auto') return value;
  return (
    (
      devices.find((d) => d.software && d.name.includes('Microsoft GS')) ||
      devices.find((d) => d.software)
    )?.id || ''
  );
}
