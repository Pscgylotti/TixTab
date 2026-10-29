import { it, expect } from 'vitest';
import { newNotebook } from './model';
import { encodeProject, decodeProject } from './storage';
import type { MusicPlayerState } from './musicPlayerState';

it('round-trips player preferences through repeated project imports and accepts older projects', () => {
  const n = newNotebook();
  expect(decodeProject(encodeProject(n)).musicPlayer).toBeUndefined();
  n.musicPlayer = {
    open: true,
    collapsed: true,
    tempo: 73,
    volume: 0.4,
    instrument: 40,
    output: 'internal',
    followEngine: 'cqt',
    position: { x: 200, y: 300 },
    cursor: { pageId: n.pages[0].id, beat: 2.5 },
  };
  expect(decodeProject(encodeProject(decodeProject(encodeProject(n))))).toEqual(n);
  for (const change of [
    { tempo: 0 },
    { volume: 2 },
    { instrument: 128 },
    { open: 'yes' },
    { position: { x: null, y: 20 } },
    { cursor: { pageId: 'p', beat: -1 } },
  ]) {
    expect(() =>
      decodeProject(
        encodeProject({ ...n, musicPlayer: { ...n.musicPlayer, ...change } as MusicPlayerState }),
      ),
    ).toThrow();
  }
});
