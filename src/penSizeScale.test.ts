import { expect, it } from 'vitest';
import { penSizeFromSlider, penSizeToSlider } from './penSizeScale';
it('assigns equal slider halves to 0.5–3 and 3–12 with stable inverse mapping', () => {
  expect([0, 25, 50, 75, 100].map(penSizeFromSlider)).toEqual([0.5, 1.75, 3, 7.5, 12]);
  for (const size of [0.5, 1, 2.8, 3, 6, 9, 12])
    expect(penSizeFromSlider(penSizeToSlider(size))).toBeCloseTo(size, 2);
});
