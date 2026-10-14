import { describe, it, expect } from 'vitest';
import { fitPageZoom, fitPageWithControls, fitWidthZoom } from './pageFit';
describe('fit visible PDF page edges', () => {
  it('fits width independently of tall page height and uses the widest continuous page', () => {
    const pages = [
      { width: 600, height: 1600 },
      { width: 900, height: 700 },
    ];
    expect(fitWidthZoom(pages, 0, 'single', 1216)).toBe(2);
    expect(fitWidthZoom(pages, 0, 'continuous', 1216)).toBeCloseTo(1200 / 900);
    expect(fitWidthZoom(pages, 0, 'dual', 1532)).toBe(1);
    expect(fitWidthZoom(pages, 1, 'dual', 916)).toBe(1);
  });
  it('fills the viewport for small pages without the old 160% cap', () => {
    expect(fitPageZoom([{ width: 200, height: 300 }], 0, 'single', 1000, 900)).toBeCloseTo(
      884 / 300,
    );
  });
  it('fits both pages using the taller height and a fixed spread gap', () => {
    expect(
      fitPageZoom(
        [
          { width: 600, height: 400 },
          { width: 300, height: 900 },
        ],
        0,
        'dual',
        1200,
        800,
      ),
    ).toBeCloseTo((800 - 16 - 36) / 900);
  });
  it('continuous fit shows the full active page rather than fitting width alone', () => {
    expect(fitPageZoom([{ width: 600, height: 1200 }], 0, 'continuous', 1400, 700)).toBeCloseTo(
      (700 - 16 - 25) / 1200,
    );
  });
  it('a final unpaired page uses its own width and no empty second slot', () => {
    expect(
      fitPageZoom(
        [
          { width: 600, height: 900 },
          { width: 300, height: 200 },
        ],
        1,
        'dual',
        1000,
        900,
      ),
    ).toBeCloseTo(984 / 300);
  });
  it('uses transparent space beside a tall side dock, while avoiding the center navigation', () => {
    const size = [{ width: 400, height: 800 }],
      controls = [
        { left: 20, right: 250, top: 700, bottom: 780 },
        { left: 550, right: 650, top: 750, bottom: 790 },
      ];
    const result = fitPageWithControls(size, 0, 'single', 1200, 900, controls);
    expect(result.inset).toBe(158);
    expect(result.zoom).toBeCloseTo((742 - 16) / 800);
    expect(result.zoom).toBeGreaterThan(fitPageZoom(size, 0, 'single', 1200, 692));
  });
  it('includes the full canvas when the paper clears all controls without a reserved strip', () => {
    expect(
      fitPageWithControls([{ width: 1000, height: 200 }], 0, 'single', 1200, 900, [
        { left: 500, right: 700, top: 800, bottom: 850 },
      ]).inset,
    ).toBe(0);
  });
});
