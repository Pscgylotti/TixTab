import { getPressureCurve, getPressureMapper } from './pressureCurve';

/** Excalidraw's pinned version reads PointerEvent.pressure directly. Adapt only
 * new pen events inside its canvas; never rewrite saved scene elements. */
export function installSketchPressure(root: HTMLElement) {
  let pointer: number | null = null,
    map = getPressureMapper(),
    custom = false;
  const seen = new WeakSet<Event>();
  const adapt = (event: PointerEvent) => {
    if (event.pointerType !== 'pen' || event.button === 5 || event.buttons & 32) return;
    if (event.type === 'pointerdown') {
      pointer = event.pointerId;
      map = getPressureMapper();
      custom = getPressureCurve().some(([x, y]) => x !== y);
    }
    if (pointer !== event.pointerId || !custom || seen.has(event)) return;
    seen.add(event);
    let pressure = map(event.pressure);
    // Excalidraw uses exactly .5 as its mouse/simulated-pressure sentinel.
    if (pressure === 0.5) pressure += 0.000001;
    Object.defineProperty(event, 'pressure', { value: pressure, configurable: true });
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId === pointer) pointer = null;
  };
  root.addEventListener('pointerdown', adapt, true);
  root.addEventListener('pointermove', adapt, true);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return () => {
    root.removeEventListener('pointerdown', adapt, true);
    root.removeEventListener('pointermove', adapt, true);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    pointer = null;
  };
}
