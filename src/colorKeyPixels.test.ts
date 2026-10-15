import { expect, it } from 'vitest';
import { colorKeyPixels } from './colorKeyPixels';
it('keys RGB inclusive per-channel bounds and preserves original alpha elsewhere', () => {
  const pixels = Uint8ClampedArray.from([
    255, 255, 255, 255, 252, 253, 254, 180, 251, 255, 255, 99, 0, 0, 0, 0,
  ]);
  colorKeyPixels(pixels, [255, 255, 255], 3);
  expect([...pixels]).toEqual([255, 255, 255, 0, 252, 253, 254, 0, 251, 255, 255, 99, 0, 0, 0, 0]);
});
