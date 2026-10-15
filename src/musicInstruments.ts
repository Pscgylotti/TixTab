/** General MIDI program numbers are zero-based in the MIDI stream. */
export const musicInstruments = [
  [0, '钢琴'],
  [4, '电钢琴'],
  [6, '羽管键琴'],
  [8, '钢片琴'],
  [10, '八音盒'],
  [11, '颤音琴'],
  [16, '电风琴'],
  [19, '管风琴'],
  [24, '尼龙弦吉他'],
  [25, '钢弦吉他'],
  [32, '原声贝斯'],
  [40, '小提琴'],
  [42, '大提琴'],
  [48, '弦乐合奏'],
  [56, '小号'],
  [60, '圆号'],
  [65, '中音萨克斯'],
  [68, '双簧管'],
  [71, '单簧管'],
  [73, '长笛'],
  [80, '方波合成器'],
  [81, '锯齿波合成器'],
] as const;
export function savedMusicInstrument() {
  try {
    const n = Number(localStorage.getItem('tixtab.musicInstrument'));
    return musicInstruments.some((i) => i[0] === n) ? n : 0;
  } catch {
    return 0;
  }
}
export function saveMusicInstrument(program: number) {
  try {
    localStorage.setItem('tixtab.musicInstrument', String(program));
  } catch {}
}
/** Lightweight local synthesis; no sampled soundfont is downloaded. */
export function instrumentVoice(program: number): {
  type: OscillatorType;
  attack: number;
  sustain: number;
  decay: boolean;
  harmonics?: number[];
} {
  const family = Math.floor(program / 8);
  if (family === 0)
    return {
      type: 'custom',
      attack: 0.008,
      sustain: 0.025,
      decay: true,
      harmonics:
        program === 4 ? [1, 0.05, 0.32, 0.02, 0.08] : [1, 0.55, 0.24, 0.12, 0.08, 0.04, 0.02],
    };
  if (family === 1)
    return {
      type: 'custom',
      attack: 0.005,
      sustain: 0.015,
      decay: true,
      harmonics: [1, 0.02, 0.35, 0.01, 0.12, 0.02],
    };
  if (family === 2)
    return {
      type: 'custom',
      attack: 0.012,
      sustain: 0.6,
      decay: false,
      harmonics: [1, 0.8, 0.5, 0.4, 0.2, 0.15],
    };
  if (family === 3 || family === 4)
    return {
      type: 'custom',
      attack: 0.006,
      sustain: 0.02,
      decay: true,
      harmonics: [1, 0.45, 0.2, 0.08, 0.04],
    };
  if (family === 5 || family === 6)
    return { type: 'sawtooth', attack: 0.07, sustain: 0.3, decay: false };
  if (family === 7) return { type: 'sawtooth', attack: 0.025, sustain: 0.4, decay: false };
  if (family === 8)
    return {
      type: program === 71 ? 'square' : 'triangle',
      attack: 0.025,
      sustain: 0.35,
      decay: false,
    };
  if (family === 9) return { type: 'sine', attack: 0.035, sustain: 0.4, decay: false };
  return {
    type: program === 80 ? 'square' : 'sawtooth',
    attack: 0.015,
    sustain: 0.3,
    decay: false,
  };
}
