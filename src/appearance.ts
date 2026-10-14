import { useSyncExternalStore } from 'react';
export type PowerMode = 'auto' | 'eco' | 'quality';
export type RenderQuality = 'standard' | 'high' | 'ultra';
export const preRenderChoices = [0, 0.5, 1, 2, 3, 4] as const;
export type PreRenderRange = (typeof preRenderChoices)[number];
function saved(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
let night = saved('surfacetab.night', 'false') === 'true';
let mode = saved('surfacetab.powerMode', 'auto') as PowerMode;
if (!['auto', 'eco', 'quality'].includes(mode)) mode = 'auto';
let quality = saved('surfacetab.renderQuality', 'high') as RenderQuality;
if (!['standard', 'high', 'ultra'].includes(quality)) quality = 'high';
let preRender = Number(saved('tixtab.preRenderRange', '1')) as PreRenderRange;
if (!preRenderChoices.includes(preRender)) preRender = 1;
let battery = false,
  original = false,
  revision = 0;
const listeners = new Set<() => void>();
function changed() {
  revision++;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.night = String(night);
    document.documentElement.dataset.eco = String(renderPolicy().eco);
  }
  listeners.forEach((fn) => fn());
}
export function subscribeAppearance(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function useAppearance() {
  useSyncExternalStore(subscribeAppearance, () => revision);
  return { night, mode, quality, battery, original, preRender, pdfNight: night && !original };
}
export function setNight(value: boolean) {
  night = value;
  original = false;
  try {
    localStorage.setItem('surfacetab.night', String(night));
  } catch {}
  void window.surfaceDesktop?.setNight?.(night);
  changed();
}
export function setOriginal(value: boolean) {
  original = value;
  changed();
}
export function isPdfNight() {
  return night && !original;
}
export function setPowerMode(value: PowerMode) {
  mode = value;
  try {
    localStorage.setItem('surfacetab.powerMode', mode);
  } catch {}
  changed();
}
export function setRenderQuality(value: RenderQuality) {
  if (!['standard', 'high', 'ultra'].includes(value)) return;
  quality = value;
  try {
    localStorage.setItem('surfacetab.renderQuality', quality);
  } catch {}
  changed();
}
export function renderPolicy() {
  const eco = mode === 'eco' || (mode === 'auto' && battery);
  const level = quality === 'standard' ? 0 : quality === 'high' ? 1 : 2;
  return {
    eco,
    concurrency: eco ? 1 : 2,
    sampling: [1, 1.5, 2][level],
    baseScale: (eco ? [1, 2, 3] : [1.5, 3, 4])[level],
    basePixels: (eco ? [2, 4, 6] : [6, 8, 12])[level] * 1_000_000,
    readingPixels: (eco ? [1, 3, 5] : [2, 6, 10])[level] * 1_000_000,
    detailPixels: (eco ? [2, 4, 6] : [6, 8, 12])[level] * 1_000_000,
    viewPixels: (eco ? [1.2, 3, 5] : [3, 6, 10])[level] * 1_000_000,
    dpr: eco ? 1.25 : 2,
    settleMs: eco ? 320 : 200,
    detailMs: eco ? 280 : 160,
    cacheBytes: (eco ? 32 : 48) * 1024 * 1024,
    extraPageBytes: (eco ? 120 : 200) * 1024 * 1024,
  };
}
export function setPreRenderRange(value: PreRenderRange) {
  if (!preRenderChoices.includes(value)) return;
  preRender = value;
  try {
    localStorage.setItem('tixtab.preRenderRange', String(value));
  } catch {}
  changed();
}
export function quantizeRenderScale(scale: number) {
  return Math.max(0.125, Math.floor(scale * 8) / 8);
}
export function renderDensity(deviceDpr: number, policy = renderPolicy()) {
  return Math.min(Math.max(1, deviceDpr), policy.dpr) * policy.sampling;
}
/** Round the desired resolution up, without crossing either pixel or scale cap. */
export function pageRenderScale(
  zoom: number,
  deviceDpr: number,
  width: number,
  height: number,
  reading: boolean,
  policy = renderPolicy(),
) {
  const cap = Math.min(
    policy.baseScale,
    Math.sqrt((reading ? policy.readingPixels : policy.basePixels) / Math.max(1, width * height)),
  );
  const target = Math.max(
    reading ? 0.125 : policy.sampling,
    zoom * renderDensity(deviceDpr, policy),
  );
  return Math.min(
    quantizeRenderScale(cap),
    Math.max(0.125, Math.ceil(Math.min(target, cap) * 8) / 8),
  );
}
export function initializeAppearance() {
  changed();
  void window.surfaceDesktop?.setNight?.(night);
  const power = (value: boolean) => {
    if (battery !== value) {
      battery = value;
      changed();
    }
  };
  if (window.surfaceDesktop?.getOnBattery) {
    void window.surfaceDesktop
      .getOnBattery()
      .then(power)
      .catch(() => {});
    window.surfaceDesktop.onPower?.(power);
  } else {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        charging: boolean;
        addEventListener: (type: string, fn: () => void) => void;
      }>;
    };
    void nav
      .getBattery?.()
      .then((state) => {
        power(!state.charging);
        state.addEventListener('chargingchange', () => power(!state.charging));
      })
      .catch(() => {});
  }
}
