export type PressurePoint = readonly [number, number];
export const MAX_PRESSURE_POINTS = 16;
export const LINEAR_PRESSURE: readonly PressurePoint[] = [
  [0, 0],
  [1, 1],
];
const key = 'tixtab.pressureCurve';
export function normalizePressureCurve(value: unknown): readonly PressurePoint[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_PRESSURE_POINTS + 2)
    return LINEAR_PRESSURE;
  if (
    !value.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1),
    )
  )
    return LINEAR_PRESSURE;
  if (
    value[0][0] !== 0 ||
    value[0][1] !== 0 ||
    value.at(-1)[0] !== 1 ||
    value.at(-1)[1] !== 1 ||
    value.some((p, i) => i && p[0] <= value[i - 1][0])
  )
    return LINEAR_PRESSURE;
  return value.map((p) => Object.freeze([p[0], p[1]] as const));
}
export function compilePressureCurve(points: readonly PressurePoint[]) {
  const curve = normalizePressureCurve(points);
  if (curve.every(([x, y]) => x === y))
    return (p: number) => Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0));
  const slopes = curve.slice(1).map(([x, y], i) => (y - curve[i][1]) / (x - curve[i][0]));
  return (input: number) => {
    const p = Math.max(0, Math.min(1, Number.isFinite(input) ? input : 0));
    let lo = 0,
      hi = curve.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (p < curve[mid][0]) hi = mid;
      else lo = mid;
    }
    return curve[lo][1] + (p - curve[lo][0]) * slopes[lo];
  };
}
let saved: readonly PressurePoint[] | undefined;
let mapper: ((p: number) => number) | undefined;
export function getPressureCurve() {
  if (!saved) {
    try {
      saved = normalizePressureCurve(JSON.parse(localStorage.getItem(key) ?? 'null'));
    } catch {
      saved = LINEAR_PRESSURE;
    }
  }
  return saved;
}
export function getPressureMapper() {
  return (mapper ??= compilePressureCurve(getPressureCurve()));
}
export function savePressureCurve(value: readonly PressurePoint[]) {
  saved = normalizePressureCurve(value);
  mapper = compilePressureCurve(saved);
  try {
    localStorage.setItem(key, JSON.stringify(saved));
  } catch {
    /* Session preference. */
  }
}
