import { expect, it } from 'vitest';
import { LatexHistory } from './latexHistory';
it('coalesces typing, restores caret and treats recognition/paste as separate edits', () => {
  const h = new LatexHistory('x');
  h.commit('xy', 2, 'insertText', 100);
  h.commit('xyz', 3, 'insertText', 200);
  expect(h.undo()).toEqual({ value: 'x', position: 1 });
  expect(h.redo()).toEqual({ value: 'xyz', position: 3 });
  h.move(1);
  h.commit('x\\alpha yz', 8, '', 300);
  expect(h.undo()).toEqual({ value: 'xyz', position: 1 });
  h.commit('other', 2, '', 400);
  expect(h.canRedo).toBe(false);
});
it('bounds retained history, resets draft loading baseline and does not group whole replacements', () => {
  const h = new LatexHistory('');
  h.commit('x', 1, 'insertText', 1);
  h.commit('x^2', 3, 'insertText', 2);
  expect(h.undo()?.value).toBe('x');
  h.reset('restored', 3);
  expect(h.canUndo).toBe(false);
  for (let i = 0; i < 150; i++) h.commit('value' + i, 3, '', i);
  let count = 0;
  while (h.undo()) count++;
  expect(count).toBe(100);
});
