import { expect, it } from 'vitest';
import { PdfViewport } from './pdfViewport';
it('maps cropped pages, all rotations, UserUnit and offsets with reversible coordinates', () => {
  for (const rotation of [0, 90, 180, 270])
    for (const userUnit of [1, 2.5])
      for (const scale of [0.125, 1, 4])
        for (const dontFlip of [false, true]) {
          const v = new PdfViewport(
            { view: [40, 60, 440, 660], rotation, userUnit, objectNumber: 1 },
            { scale, offsetX: 7, offsetY: 11, dontFlip },
          );
          expect(v.width).toBe((rotation % 180 ? 600 : 400) * scale * userUnit);
          expect(v.height).toBe((rotation % 180 ? 400 : 600) * scale * userUnit);
          const corners = [
            [40, 60],
            [440, 660],
            [40, 660],
            [440, 60],
          ].map(([x, y]) => v.convertToViewportPoint(x, y));
          expect(Math.min(...corners.map((p) => p[0]))).toBeCloseTo(7);
          expect(Math.min(...corners.map((p) => p[1]))).toBeCloseTo(11);
          expect(Math.max(...corners.map((p) => p[0]))).toBeCloseTo(7 + v.width);
          expect(Math.max(...corners.map((p) => p[1]))).toBeCloseTo(11 + v.height);
          const p = v.convertToPdfPoint(
            ...(v.convertToViewportPoint(123.4, 456.7) as [number, number]),
          );
          expect(p[0]).toBeCloseTo(123.4);
          expect(p[1]).toBeCloseTo(456.7);
          expect(v.clone({ scale: 2 }).scale).toBe(2);
        }
});
