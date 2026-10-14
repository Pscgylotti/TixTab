import { expect, it } from 'vitest';
import { pageSelectionRange } from './pageSelection';
it('adds/removes a reversible range without losing independent selections', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  expect(pageSelectionRange(ids, ['e'], 1, 3)).toEqual(['b', 'c', 'd', 'e']);
  expect(pageSelectionRange(ids, ['e'], 1, 2)).toEqual(['b', 'c', 'e']);
  expect(pageSelectionRange(ids, ids, 3, 1, false)).toEqual(['a', 'e']);
});
