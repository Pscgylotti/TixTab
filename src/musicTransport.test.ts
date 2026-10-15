import { expect, it } from 'vitest';
import {
  estimateMidi,
  followScore,
  scoreTimeline,
  scoreAt,
  timelineNotes,
  cursorNote,
  scoreAnchors,
} from './musicTransport';
import { scoreMidi } from './musicMidi';
import { validMusicScore, correctScoreNote, type MusicScore } from './musicScore';
import { blankPage } from './model';
import { transformPage } from './pageOperations';
const region = { x: 0.2, y: 0.3, width: 0.02, height: 0.03 };
const score: MusicScore = {
  version: 1,
  engine: 'import',
  musicxml: '<score-partwise/>',
  notes: [
    {
      id: 'n',
      sourceId: 'n',
      midi: 69,
      beat: 0,
      duration: 1,
      measure: '1',
      part: 'p',
      system: 0,
      region,
    },
  ],
  systems: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.2 }],
  duration: 4,
  tempo: 120,
  positioning: 'layout',
};
it('bounds audio pitch estimates and advances near the matching note', () => {
  const input = Float32Array.from(
    { length: 2048 },
    (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000),
  );
  expect(estimateMidi(input, 48000)).toBe(69);
  expect(estimateMidi(new Float32Array(2048), 48000)).toBeNull();
  expect(followScore(score.notes, 0, 69)?.id).toBe('n');
  expect(followScore(score.notes, 0, 64)).toBeUndefined();
});
it('joins recognized pages, exports corrected MIDI and keeps score geometry valid after page edits', () => {
  const p = { ...blankPage(), score },
    timeline = scoreTimeline([p, blankPage(), { ...p, id: 'p2' }]);
  expect(timeline.map((p) => p.start)).toEqual([0, 4]);
  expect(scoreAt(timeline, 5)?.pageId).toBe('p2');
  expect(timelineNotes(timeline).map((n) => n.beat)).toEqual([0, 4]);
  const midi = scoreMidi([{ ...score.notes[0], midi: 72 }], 90, 40);
  expect(midi[[...midi].indexOf(0xc0) + 1]).toBe(40);
  expect(new TextDecoder().decode(midi.slice(0, 4))).toBe('MThd');
  expect([...midi]).toContain(72);
  for (const operation of [
    { action: 'rotate', angle: 90 },
    { action: 'crop', margins: { left: 30, right: 10, top: 30, bottom: 0 } },
  ] as const)
    expect(validMusicScore(transformPage(p, operation).score)).toBe(true);
});

it('holds the cursor at printed onsets, chooses one chord anchor and follows ties across rows', () => {
  const a = {
    ...score.notes[0],
    duration: 4,
    continuations: [{ beat: 2, duration: 2, system: 1, region: { ...region, x: 0.15 } }],
  };
  const chord = {
    ...a,
    id: 'chord',
    sourceId: 'chord',
    region: { ...region, x: 0.21 },
    continuations: undefined,
  };
  const b = { ...score.notes[0], id: 'b', sourceId: 'b', beat: 4, region: { ...region, x: 0.83 } };
  const s = {
    ...score,
    notes: [a, chord, b],
    systems: [score.systems[0], { ...score.systems[0], y: 0.6 }],
    duration: 8,
  };
  expect(validMusicScore(s)).toBe(true);
  expect(correctScoreNote(s, 'n', { duration: 1 }).notes[0].continuations).toEqual([]);
  const anchors = scoreAnchors(s);
  expect(cursorNote(s, -0.1, anchors)).toBeUndefined();
  expect(cursorNote(s, 1.99, anchors)?.region.x).toBe(0.2);
  expect(cursorNote(s, 2, anchors)?.system).toBe(1);
  expect(cursorNote(s, 3.99, anchors)?.region.x).toBe(0.15);
  expect(cursorNote(s, 4, anchors)?.region.x).toBe(0.83);
  expect(timelineNotes(scoreTimeline([{ ...blankPage(), score: s }]))).toHaveLength(3);
});
