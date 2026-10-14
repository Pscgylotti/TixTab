import { expect, it } from 'vitest';
import { moveTextSelection } from './keyboardSelection';
it('extends and reverses selection at the original anchor without splitting surrogate pairs', () => {
  expect(moveTextSelection('a😀bc', 3, 3, 'none', 'ArrowLeft', true)).toEqual({
    start: 1,
    end: 3,
    direction: 'backward',
  });
  expect(moveTextSelection('a😀bc', 1, 3, 'backward', 'ArrowRight', true)).toEqual({
    start: 3,
    end: 3,
    direction: 'forward',
  });
  expect(moveTextSelection('a😀bc', 1, 3, 'forward', 'ArrowLeft', false)).toEqual({
    start: 1,
    end: 1,
    direction: 'none',
  });
});
it('moves to line boundaries and clamps vertical movement to adjacent lines', () => {
  expect(moveTextSelection('abcd\nx\n1234', 3, 3, 'none', 'ArrowDown', false).start).toBe(6);
  expect(moveTextSelection('abcd\nx\n1234', 9, 9, 'none', 'ArrowUp', false).start).toBe(6);
  expect(moveTextSelection('abcd\nx\n1234', 9, 9, 'none', 'Home', false).start).toBe(7);
  expect(moveTextSelection('abcd\nx\n1234', 8, 8, 'none', 'End', true)).toEqual({
    start: 8,
    end: 11,
    direction: 'forward',
  });
});
