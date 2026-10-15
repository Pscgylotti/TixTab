import { expect, it } from 'vitest';
import { stableInkSamples } from './inkSimplify';
import { inkCurve, smoothInkPath } from './inkCurve';
import { finalInkPath } from './ink';
import { PDFDocument } from 'pdf-lib';
import type { Stroke } from './model';
it('adding raw samples cannot change the previously accepted centerline', () => {
  const points: Stroke['points'] = Array.from({ length: 400 }, (_, i) => [
    i * 0.1,
    Math.sin(i * 0.06) * 3 + Math.sin(i * 2.3) * 0.07,
    0.5,
  ]);
  for (const size of [0.5, 3, 12]) {
    const complete = stableInkSamples(points, size);
    for (const end of [40, 80, 150, 300]) {
      const prefix = stableInkSamples(points.slice(0, end), size).slice(0, -1);
      expect(complete.slice(0, prefix.length)).toEqual(prefix);
    }
  }
});
it('live canvas and saved SVG use the same smooth controls, and PDF export accepts them', async () => {
  const points = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    commands: string[] = [];
  inkCurve(points, {
    moveTo: (x, y) => commands.push(`M ${x},${y}`),
    quadraticCurveTo: (cx, cy, x, y) => commands.push(`Q ${cx},${cy} ${x},${y}`),
    closePath: () => commands.push('Z'),
  });
  expect(smoothInkPath(points)).toBe(commands.join(' '));
  const path = finalInkPath({
    id: 'curve',
    tool: 'pen',
    color: '#123456',
    size: 12,
    points: [
      [30, 30, 0.5],
      [33, 34, 0.6],
      [38, 32, 0.7],
    ],
  });
  expect(path).toContain(' Q ');
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]).drawSvgPath(path);
  expect((await pdf.save()).length).toBeGreaterThan(500);
});
