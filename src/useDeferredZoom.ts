import { useEffect, useRef, useState } from 'react';
import { performanceDelay } from './performanceLedger';

/** Keep a pinch or wheel zoom inside the page view. The view follows every
 * frame; the application shell (zoom readout, autosave, toolbars) hears about
 * it a few times a second and once more when the gesture settles, instead of
 * re-rendering on every frame. Zoom set by the shell is adopted immediately. */
export function useDeferredZoom(
  committed: number,
  commit: (zoom: number) => void,
  /** Changes when the shell repositions the view, e.g. fit to page. */
  resetKey: unknown,
  interval = 150,
): [number, (zoom: number) => void] {
  const [live, setLive] = useState(committed);
  const state = useRef({
    seen: committed,
    reset: resetKey,
    sent: committed,
    pending: null as number | null,
    cancel: undefined as (() => void) | undefined,
    commit,
  });
  const s = state.current;
  s.commit = commit;
  if (s.reset !== resetKey) {
    // The shell's value wins even when it equals the last one it was told about,
    // which a still-unreported gesture would otherwise override a moment later.
    s.reset = resetKey;
    s.seen = s.sent = committed;
    s.pending = null;
    s.cancel?.();
    s.cancel = undefined;
    if (live !== committed) setLive(committed);
  } else if (s.seen !== committed) {
    s.seen = committed;
    // Our own report coming back must not rewind a gesture that kept moving.
    if (committed !== s.sent) {
      s.sent = committed;
      s.pending = null;
      if (live !== committed) setLive(committed);
    }
  }
  const report = () => {
    s.cancel = undefined;
    if (s.pending === null) return;
    const value = s.pending;
    s.pending = null;
    s.sent = value;
    s.commit(value);
  };
  useEffect(
    () => () => {
      s.cancel?.();
      report();
    },
    [],
  );
  const set = (zoom: number) => {
    setLive(zoom);
    s.pending = zoom;
    // A tracked delay: the report re-renders the shell, so the view is not
    // settled for measurement or capture until it has been delivered.
    s.cancel ??= performanceDelay('view-settle', report, interval);
  };
  return [s.pending ?? live, set];
}
