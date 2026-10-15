import { expect, it } from 'vitest';
import { clippedCaptureBox } from './captureGeometry';
it('clips outside starts and releases, including reverse drags and all-page selection', () => {
  const page = { left: 100, top: 200, right: 500, bottom: 800 };
  expect(clippedCaptureBox(page, 20, 300, 300, 900)).toEqual({
    x: 100,
    y: 300,
    width: 200,
    height: 500,
  });
  expect(clippedCaptureBox(page, 600, 900, 20, 100)).toEqual({
    x: 100,
    y: 200,
    width: 400,
    height: 600,
  });
  expect(clippedCaptureBox(page, 20, 400, 50, 500)).toEqual({
    x: 100,
    y: 400,
    width: 0,
    height: 100,
  });
  expect(clippedCaptureBox(page, 300, 400, 20, 100)).toEqual({
    x: 100,
    y: 200,
    width: 200,
    height: 200,
  });
});
