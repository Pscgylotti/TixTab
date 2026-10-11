const key = 'surfacetab.modelIdleSeconds';
export const DEFAULT_MODEL_IDLE_SECONDS = 1800;
export const validModelIdleSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 30 && value <= 86400;
let seconds = DEFAULT_MODEL_IDLE_SECONDS;
const listeners = new Set<() => void>();
export function getModelIdleSeconds() {
  try {
    const value = Number(localStorage.getItem(key));
    if (validModelIdleSeconds(value)) seconds = value;
  } catch {
    /* Session preference remains usable. */
  }
  return seconds;
}
export function setModelIdleSeconds(value: number) {
  if (!validModelIdleSeconds(value)) throw Error('invalid-idle-seconds');
  seconds = value;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* Session preference. */
  }
  listeners.forEach((listener) => listener());
  // Update an already running service; this never starts one or loads weights.
  void fetch('http://127.0.0.1:8766/models/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idleReleaseSeconds: value }),
    signal: AbortSignal.timeout(1200),
  }).catch(() => {});
  void window.surfaceDesktop?.dictation
    ?.run({ action: 'idle-policy', idleReleaseSeconds: value })
    .catch(() => {});
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (event.key === key) {
      getModelIdleSeconds();
      listeners.forEach((listener) => listener());
    }
  });
}
/** A single deadline, re-armed against the original idle start when preferences change. */
export function scheduleModelIdle(release: () => void): () => void {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const cancel = () => {
    clearTimeout(timer);
    listeners.delete(arm);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        cancel();
        release();
      },
      Math.max(0, getModelIdleSeconds() * 1000 - (Date.now() - started)),
    );
  };
  listeners.add(arm);
  arm();
  return cancel;
}
