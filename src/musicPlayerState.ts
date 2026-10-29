/** Portable preferences only: reopening a project never starts audio or the microphone. */
export interface MusicPlayerState {
  open: boolean;
  collapsed?: boolean;
  tempo?: number;
  volume?: number;
  instrument?: number;
  output?: string;
  followEngine?: 'global' | 'matchmaker' | 'cqt';
  position?: { x: number; y: number };
  cursor?: { pageId: string; beat: number };
}

export function validMusicPlayerState(value: unknown): value is MusicPlayerState {
  if (!value || typeof value !== 'object') return false;
  const s = value as MusicPlayerState;
  const range = (n: number | undefined, min: number, max: number) =>
    n === undefined || (Number.isFinite(n) && n >= min && n <= max);
  return (
    typeof s.open === 'boolean' &&
    (s.collapsed === undefined || typeof s.collapsed === 'boolean') &&
    range(s.tempo, 20, 400) &&
    range(s.volume, 0, 1) &&
    (s.instrument === undefined ||
      (Number.isInteger(s.instrument) && range(s.instrument, 0, 127))) &&
    (s.output === undefined || (typeof s.output === 'string' && s.output.length <= 1024)) &&
    (s.followEngine === undefined || ['global', 'matchmaker', 'cqt'].includes(s.followEngine)) &&
    (s.position === undefined ||
      (!!s.position &&
        ['x', 'y'].every((k) => {
          const n = s.position![k as 'x' | 'y'];
          return Number.isFinite(n) && Math.abs(n) <= 100000;
        }))) &&
    (s.cursor === undefined ||
      (!!s.cursor &&
        typeof s.cursor.pageId === 'string' &&
        s.cursor.pageId.length <= 200 &&
        Number.isFinite(s.cursor.beat) &&
        s.cursor.beat >= 0 &&
        s.cursor.beat <= 10000000))
  );
}
