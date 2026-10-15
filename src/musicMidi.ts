import type { ScoreNote } from './musicScore';
const vlq = (n: number) => {
  const out = [n & 127];
  while ((n >>= 7)) out.unshift((n & 127) | 128);
  return out;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const int32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** Type 0 standard MIDI, 480 ticks/quarter; corrections and muted notes are respected. */
export function scoreMidi(notes: ScoreNote[], tempo: number, program = 0) {
  const events = notes
    .filter((n) => !n.muted)
    .flatMap((n) => [
      { tick: Math.round(n.beat * 480), bytes: [0x90, n.midi, 90] },
      { tick: Math.round((n.beat + n.duration) * 480), bytes: [0x80, n.midi, 0] },
    ])
    .sort((a, b) => a.tick - b.tick || a.bytes[0] - b.bytes[0]);
  const us = Math.round(60000000 / tempo),
    track = [
      0,
      0xff,
      0x51,
      3,
      (us >>> 16) & 255,
      (us >>> 8) & 255,
      us & 255,
      0,
      0xc0,
      Math.max(0, Math.min(127, Math.round(program))),
    ];
  let tick = 0;
  for (const event of events) {
    track.push(...vlq(event.tick - tick), ...event.bytes);
    tick = event.tick;
  }
  track.push(0, 0xff, 0x2f, 0);
  return Uint8Array.from([
    ...ascii('MThd'),
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    1,
    1,
    224,
    ...ascii('MTrk'),
    ...int32(track.length),
    ...track,
  ]);
}
