import { expect, it } from 'vitest';
import { ScoreCqt, ScoreFollower, featureDistance, pitchFeature } from './musicFollow';

const phrase = [
  60, 64, 67, 62, 69, 65, 71, 67, 72, 69, 74, 71, 65, 67, 64, 60, 62, 65, 69, 72, 67, 71, 74, 76,
];
const notes = phrase.map((midi, beat) => ({ midi, beat, duration: 1 }));
const chord = (midi: number) => [midi, midi + 4, midi + 7];
function signal(pitches: number[], rate = 48000) {
  return Float32Array.from({ length: 16384 }, (_, i) =>
    pitches.reduce((s, p) => {
      const phase = (2 * Math.PI * 440 * 2 ** ((p - 69) / 12) * i) / rate;
      return (
        s +
        (0.12 * Math.sin(phase) + 0.03 * Math.sin(phase * 2) + 0.01 * Math.sin(phase * 3)) /
          pitches.length
      );
    }, 0),
  );
}
it('extracts polyphonic CQT features, rejects silence and keeps pitch distinctions', () => {
  const cqt = new ScoreCqt();
  for (const rate of [44100, 48000]) {
    const f = cqt.extract(signal(chord(60), rate), rate);
    expect(f.voiced).toBe(true);
    expect(featureDistance(f.feature, pitchFeature(chord(60)))).toBeLessThan(0.25);
    expect(featureDistance(f.feature, pitchFeature(chord(61)))).toBeGreaterThan(0.6);
  }
  expect(cqt.extract(new Float32Array(16384), 48000).voiced).toBe(false);
});
it('aligns recent polyphonic audio across pages despite tempo changes, without jumping on silence', () => {
  const poly = notes.flatMap((n) => chord(n.midi).map((midi) => ({ ...n, midi })));
  const follower = new ScoreFollower(poly, 120);
  const matches: number[] = [];
  let actualBeat = 0;
  for (let i = 0; i < 110; i++) {
    actualBeat += (i < 60 ? 1.8 : 2.3) * 0.1;
    const feature = pitchFeature(chord(phrase[Math.min(23, Math.floor(actualBeat))]));
    const r = follower.push(feature, i * 0.1, true);
    if (r?.beat !== undefined) {
      expect(i).toBeGreaterThanOrEqual(50);
      expect(Math.abs(r.beat - actualBeat)).toBeLessThan(1.5);
      matches.push(r.beat);
    }
  }
  expect(matches.length).toBeGreaterThan(4);
  expect(matches.at(-1)).toBeGreaterThan(19);
  for (let i = 110; i < 310; i++)
    expect(follower.push(pitchFeature([]), i * 0.1, false)?.beat).toBeUndefined();
  expect(follower.bufferedFrames).toBeLessThanOrEqual(80);
});
it('acquires a later passage and resets its history on manual seek', () => {
  const follower = new ScoreFollower(notes, 120, 23);
  let result;
  for (let i = 0; i < 66; i++) {
    const beat = 6 + i * 0.2;
    result = follower.push(pitchFeature([phrase[Math.floor(beat)]]), i * 0.1, true) || result;
  }
  expect(result?.state).toBe('matched');
  expect(result?.beat).toBeGreaterThan(17);
  follower.reset(0);
  expect(follower.bufferedFrames).toBe(0);
  expect(follower.push(pitchFeature([60]), 20, true)?.state).toBe('listening');
});
it('follows synthesized microphone audio through CQT and DTW end to end', () => {
  const cqt = new ScoreCqt(),
    follower = new ScoreFollower(notes, 120);
  const features = new Map(phrase.map((midi) => [midi, cqt.extract(signal([midi]), 48000)]));
  const beats: number[] = [];
  for (let i = 0; i < 105; i++) {
    const beat = i * 0.2;
    const f = features.get(phrase[Math.floor(beat)])!;
    const result = follower.push(f.feature, i * 0.1, f.voiced);
    if (result?.beat !== undefined) {
      expect(Math.abs(result.beat - beat)).toBeLessThan(1.5);
      beats.push(result.beat);
    }
  }
  expect(beats.length).toBeGreaterThan(6);
  expect(beats.at(-1)).toBeGreaterThan(18);
});
it('does not navigate from one sustained pitch or an unrelated phrase', () => {
  for (const wrong of [false, true]) {
    const follower = new ScoreFollower(notes, 120);
    for (let i = 0; i < 100; i++) {
      const r = follower.push(
        pitchFeature([wrong ? [37, 41, 46, 50][Math.floor(i / 5) % 4] : 60]),
        i * 0.1,
        true,
      );
      expect(r?.beat).toBeUndefined();
    }
  }
});
