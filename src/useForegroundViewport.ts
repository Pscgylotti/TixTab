import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { foregroundClip, sameForegroundClip, type ForegroundClip } from './foregroundViewport';
import { performanceLedger, type PerformanceFinish } from './performanceLedger';

// One listener/observer/frame for all foreground pages in a scroll surface; no idle loop.
const hubs = new WeakMap<HTMLElement, { add: (callback: () => void) => () => void }>();
function subscribe(viewport: HTMLElement, callback: () => void) {
  let hub = hubs.get(viewport);
  if (!hub) {
    const callbacks = new Set<() => void>();
    let frame = 0,
      finish: PerformanceFinish | undefined;
    const changed = () => {
      if (frame || viewport.ownerDocument.hidden) return;
      finish = performanceLedger?.begin('foreground-view');
      frame = requestAnimationFrame(() => {
        frame = 0;
        try {
          // Commit all visible-page clips together before this frame paints.
          // An ordinary concurrent state update can leave newly exposed content
          // absent for one frame after a fast scroll jump beyond the overscan.
          flushSync(() => {
            for (const measure of callbacks) measure();
          });
          finish?.();
        } catch (error) {
          finish?.('failed');
          throw error;
        } finally {
          finish = undefined;
        }
      });
    };
    const observer = new ResizeObserver(changed);
    observer.observe(viewport);
    viewport.addEventListener('scroll', changed, { passive: true });
    viewport.ownerDocument.addEventListener('visibilitychange', changed);
    viewport.ownerDocument.defaultView?.addEventListener('resize', changed);
    hub = {
      add(measure) {
        callbacks.add(measure);
        return () => {
          callbacks.delete(measure);
          if (callbacks.size) return;
          observer.disconnect();
          cancelAnimationFrame(frame);
          finish?.('cancelled');
          viewport.removeEventListener('scroll', changed);
          viewport.ownerDocument.removeEventListener('visibilitychange', changed);
          viewport.ownerDocument.defaultView?.removeEventListener('resize', changed);
          hubs.delete(viewport);
        };
      },
    };
    hubs.set(viewport, hub);
  }
  return hub.add(callback);
}
export function useForegroundViewport(
  root: RefObject<HTMLElement | null>,
  viewport: RefObject<HTMLElement | null>,
  width: number,
  height: number,
  viewKey: string | number | undefined,
  enabled: boolean,
) {
  // Layout effects measure and synchronously commit before the first paint.
  const [clip, setClip] = useState<ForegroundClip>(false);
  const connection = useRef<{
    paper: HTMLElement;
    viewport: HTMLElement;
    dispose: () => void;
  } | null>(null);
  const measure = useRef(() => {});
  measure.current = () => {
    const paper = root.current,
      view = viewport.current;
    const next =
      enabled && paper && view
        ? foregroundClip(paper.getBoundingClientRect(), view.getBoundingClientRect(), width, height)
        : undefined;
    setClip((old) => (sameForegroundClip(old, next) ? old : next));
  };
  const connect = () => {
    const paper = root.current,
      view = viewport.current,
      current = connection.current;
    if (current && enabled && current.paper === paper && current.viewport === view) return;
    if (!current && (!enabled || !paper || !view)) return;
    current?.dispose();
    connection.current = null;
    if (enabled && paper && view) {
      const observer = new ResizeObserver(() => measure.current());
      observer.observe(paper);
      const unsubscribe = subscribe(view, () => measure.current());
      connection.current = {
        paper,
        viewport: view,
        dispose: () => {
          observer.disconnect();
          unsubscribe();
        },
      };
    }
    measure.current();
  };
  // Reconcile actual elements, not only the stable ref objects. A parent ref
  // can still be null during its child's first layout effect, or be replaced
  // without changing the ref identity. Passive setup retries after attachment;
  // the layout measurement below keeps the initial fallback fully visible.
  useLayoutEffect(connect);
  useEffect(connect);
  useLayoutEffect(
    () => () => {
      connection.current?.dispose();
      connection.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    measure.current();
  }, [width, height, viewKey, enabled]);
  return enabled ? clip : undefined;
}
