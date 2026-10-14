/** Union of clipped trace wall intervals. Never add nested or parallel spans. */
export function unionTraceMs(intervals, start, end) {
  const spans = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]) => [Math.max(start, a), Math.min(end, b)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    left = 0,
    right = 0,
    active = false;
  for (const [a, b] of spans) {
    if (!active) {
      left = a;
      right = b;
      active = true;
    } else if (a <= right) right = Math.max(right, b);
    else {
      total += right - left;
      left = a;
      right = b;
    }
  }
  return (total + (active ? right - left : 0)) / 1000;
}

export function isGCTraceName(name) {
  return (
    typeof name === 'string' &&
    (name.startsWith('V8.GC') ||
      name.startsWith('BlinkGC') ||
      /(?:^|[.:_])GC(?:$|[._])|(?:Major|Minor)GC|GarbageCollect/.test(name))
  );
}
