import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.resetModules());

describe('interface scaling uses native Chromium zoom', () => {
  it('maps the 2.0 baseline to 100% and rejects unsafe preload values', () => {
    const zoom = vi.fn();
    let bridge: any;
    runInNewContext(readFileSync('electron/preload.cjs', 'utf8'), {
      require: () => ({
        webFrame: { setZoomFactor: zoom },
        contextBridge: { exposeInMainWorld: (_: string, value: unknown) => (bridge = value) },
        ipcRenderer: {},
      }),
    });
    for (const [value, factor] of [
      [0.5, 0.25],
      [2, 1],
      [4, 2],
    ]) {
      expect(bridge.setUiScale(value)).toBe(true);
      expect(zoom).toHaveBeenLastCalledWith(factor);
    }
    for (const value of [0, 4.1, NaN, Infinity, '2', null])
      expect(bridge.setUiScale(value)).toBe(false);
    expect(zoom).toHaveBeenCalledTimes(3);
  });

  it('restores, bounds and persists the preference without touching PDF zoom', async () => {
    const store = new Map([
      ['tixtab.uiScale', '3.1'],
      ['pdfZoom', '1.25'],
    ]);
    const target = Object.assign(new EventTarget(), {
      surfaceDesktop: { setUiScale: vi.fn(() => true) },
    });
    vi.stubGlobal('window', target);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const module = await import('./uiScale');
    module.initializeUiScale();
    expect(target.surfaceDesktop.setUiScale).toHaveBeenLastCalledWith(3.1);
    expect(module.setUiScale(4.8)).toBe(true);
    expect(store.get('tixtab.uiScale')).toBe('4');
    expect(module.setUiScale(0.1)).toBe(true);
    expect(store.get('tixtab.uiScale')).toBe('0.5');
    expect(module.setUiScale(NaN)).toBe(false);
    expect(store.get('pdfZoom')).toBe('1.25');
    store.set('tixtab.uiScale', '2.5');
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'tixtab.uiScale' }));
    expect(target.surfaceDesktop.setUiScale).toHaveBeenLastCalledWith(2.5);
  });

  it('does not persist an unapplied browser/failed bridge setting', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    const module = await import('./uiScale');
    expect(module.uiScaleAvailable()).toBe(false);
    expect(module.setUiScale(3)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });
});
