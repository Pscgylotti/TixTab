import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  pageRenderScale,
  renderDensity,
  renderPolicy,
  setPowerMode,
  setRenderQuality,
} from './appearance';
import { planPdfTiles } from './pdfTiles';

afterEach(() => {
  setPowerMode('auto');
  setRenderQuality('high');
  vi.unstubAllGlobals();
});
describe('PDF clarity and bounded supersampling', () => {
  it('zoomed-out continuous pages use the screen density and improve at each clarity level', () => {
    const scales = ['standard', 'high', 'ultra'].map((value) => {
      setRenderQuality(value as 'standard');
      return pageRenderScale(0.42, 2, 595, 842, true);
    });
    expect(scales[0]).toBeGreaterThanOrEqual(0.84);
    expect(scales[1]).toBeGreaterThan(scales[0]);
    expect(scales[2]).toBeGreaterThan(scales[1]);
    setRenderQuality('high');
    expect(pageRenderScale(0.42, 1.25, 595, 842, true)).toBeGreaterThanOrEqual(0.42 * 1.25 * 1.5);
    expect(pageRenderScale(0.3, 1, 595, 842, false)).toBe(1.5);
    setRenderQuality('ultra');
    expect(pageRenderScale(0.3, 1, 595, 842, false)).toBe(2);
  });
  it('bounds large-page buffers and retains eco concurrency', () => {
    for (const quality of ['standard', 'high', 'ultra'] as const) {
      setRenderQuality(quality);
      setPowerMode('eco');
      const policy = renderPolicy();
      expect(policy.concurrency).toBe(1);
      const scale = pageRenderScale(4, 3, 2500, 3500, true);
      expect(2500 * 3500 * scale * scale).toBeLessThanOrEqual(policy.readingPixels);
      expect(renderDensity(3)).toBeLessThanOrEqual(2.5);
      const tiles = planPdfTiles(
        2000,
        3000,
        { x: 100, y: 100, width: 800, height: 1000 },
        8,
        policy.detailPixels,
      );
      expect(tiles.pixels).toBeLessThanOrEqual(policy.detailPixels);
      expect(tiles.tiles.length).toBeLessThanOrEqual(64);
    }
  });
  it('persists valid settings and rejects invalid values', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    setRenderQuality('ultra');
    expect(setItem).toHaveBeenCalledWith('surfacetab.renderQuality', 'ultra');
    setRenderQuality('oops' as 'ultra');
    expect(renderPolicy().sampling).toBe(2);
  });
});
