import { expect, it } from 'vitest';
import { reviewConnector } from './reviewGeometry';
it('connects facing edges when a card is dragged across its PDF anchor', () => {
  const region = { x: 300, y: 200, width: 150, height: 40 };
  expect(reviewConnector(region, { x: 500, y: 190, width: 240 })).toEqual({
    x1: 450,
    y1: 220,
    x2: 500,
    y2: 215,
  });
  expect(reviewConnector(region, { x: 0, y: 190, width: 240 })).toEqual({
    x1: 300,
    y1: 220,
    x2: 240,
    y2: 215,
  });
});
