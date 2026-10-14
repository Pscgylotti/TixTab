import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

export type NativePenSample = {
  pointerId: number;
  inRange: boolean;
  barrel: boolean;
  contact: boolean;
  x: number;
  y: number;
};
let hoverPoint: { x: number; y: number } | null = null;
let hoverFrame = 0;
let highlighted: HTMLElement[] = [];
function clearHover() {
  cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  hoverPoint = null;
  highlighted.forEach((el) => el.classList.remove('pen-target-hover'));
  highlighted = [];
}
export function refreshPenHover() {
  if (!hoverPoint || hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    if (!hoverPoint) return;
    const hits = document
      .elementsFromPoint(hoverPoint.x, hoverPoint.y)
      .map((el) => el.closest<HTMLElement>('[data-pen-interactive]'))
      .filter(
        (el): el is HTMLElement =>
          !!el && !!el.closest('.pen-interaction-active,.pdf-image-interactions'),
      );
    const target = hits.find((el) => el.dataset.penInteractive === 'link') ?? hits[0];
    const group = target?.dataset.linkGroup;
    const next = target
      ? group
        ? [...target.parentElement!.querySelectorAll<HTMLElement>('[data-link-group]')].filter(
            (el) => el.dataset.linkGroup === group,
          )
        : [target]
      : [];
    if (
      next.length === highlighted.length &&
      next.every((el, i) => el === highlighted[i] && el.classList.contains('pen-target-hover'))
    )
      return;
    highlighted.forEach((el) => el.classList.remove('pen-target-hover'));
    next.forEach((el) => el.classList.add('pen-target-hover'));
    highlighted = next;
  });
}
function hoverAt(x: number, y: number) {
  hoverPoint = { x, y };
  refreshPenHover();
}

type TargetSource = {
  kind: 'link' | 'image';
  hit: (x: number, y: number) => Promise<(() => void) | null>;
};
const targets = new Map<string, Set<TargetSource>>();
export function registerPenTargets(pageId: string, source: TargetSource) {
  let sources = targets.get(pageId);
  if (!sources) targets.set(pageId, (sources = new Set()));
  sources.add(source);
  return () => {
    sources.delete(source);
    if (!sources.size && targets.get(pageId) === sources) targets.delete(pageId);
  };
}
/** Resolve from PDF geometry, including a first tap before highlight DOM is ready. */
export async function activatePenTarget(pageId: string, x: number, y: number, signal: AbortSignal) {
  const sources = [...(targets.get(pageId) ?? [])].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === 'link' ? -1 : 1,
  );
  for (const source of sources) {
    if (signal.aborted) return false;
    const activate = await source.hit(x, y).catch(() => null);
    if (signal.aborted) return false;
    if (activate && targets.get(pageId)?.has(source)) {
      activate();
      return true;
    }
  }
  return false;
}

let activePage: string | null = null;
const listeners = new Set<() => void>();
function setPage(value: string | null) {
  if (value === null) clearHover();
  if (value === activePage) return;
  activePage = value;
  listeners.forEach((fn) => fn());
}
export function penInteractionPage() {
  return activePage;
}
export function usePenInteraction(pageId: string) {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => activePage === pageId,
  );
}
/** Side-button reports exist only within digitizer range. Chorded tip/barrel
 * transitions can arrive as pointermove, not another pointerdown. */
export function usePenInteractionTracking(
  fallbackPage: RefObject<string>,
  onContact: (event: PointerEvent, pageId: string, signal: AbortSignal) => void,
  inkDrag?: {
    enabled: boolean;
    handle: (
      phase: 'start' | 'move' | 'end' | 'cancel',
      event: PointerEvent,
      pageId: string,
    ) => void;
  },
) {
  const callback = useRef(onContact);
  callback.current = onContact;
  const dragCallback = useRef(inkDrag);
  dragCallback.current = inkDrag;
  useEffect(() => {
    let contact = false,
      pointerId: number | null = null;
    let pending: AbortController | undefined;
    let native: NativePenSample | null = null;
    let press: {
      event: PointerEvent;
      last: PointerEvent;
      pageId: string;
      dragging: boolean;
      signal: AbortSignal;
    } | null = null;
    const finishPress = (event: PointerEvent, cancelled = false) => {
      const current = press;
      press = null;
      if (!current) return;
      if (current.dragging)
        dragCallback.current?.handle(cancelled ? 'cancel' : 'end', event, current.pageId);
      else if (!cancelled) callback.current(current.event, current.pageId, current.signal);
    };
    const clear = () => {
      contact = false;
      pointerId = null;
      setPage(null);
    };
    const cancel = () => {
      if (press) finishPress(press.last, true);
      native = null;
      pending?.abort();
      clear();
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      const element = event.target instanceof Element ? event.target : null;
      const touching = event.pressure > 0 || !!(event.buttons & 1);
      const barrel =
        !!(event.buttons & 2) ||
        (event.button === 2 && event.type === 'pointerdown') ||
        !!(native?.inRange && native.barrel);
      if (press && event.pointerId === press.event.pointerId) {
        press.last = event;
        if (!touching || !barrel) {
          finishPress(event, touching && !press.dragging);
          event.preventDefault();
          event.stopPropagation();
        } else if (event.type === 'pointermove') {
          if (
            !press.dragging &&
            Math.hypot(event.clientX - press.event.clientX, event.clientY - press.event.clientY) >=
              6
          ) {
            press.dragging = true;
            dragCallback.current?.handle('start', press.event, press.pageId);
          }
          if (press.dragging) dragCallback.current?.handle('move', event, press.pageId);
        }
      }
      if (
        !barrel ||
        !element?.closest('.canvas-container') ||
        document.querySelector('[aria-modal="true"],.pen-tool-wheel')
      ) {
        clear();
        return;
      }
      const pageId =
        element.closest<HTMLElement>('[data-page-id]')?.dataset.pageId ?? fallbackPage.current;
      setPage(pageId);
      if (!touching) hoverAt(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      const started = touching && (!contact || pointerId !== event.pointerId);
      contact = touching;
      pointerId = event.pointerId;
      if (!started) return;
      pending?.abort();
      pending = new AbortController();
      if (dragCallback.current?.enabled) {
        press = { event, last: event, pageId, dragging: false, signal: pending.signal };
      } else callback.current(event, pageId, pending.signal);
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType === 'pen' && !event.relatedTarget) {
        cancel();
      }
    };
    const cancelled = (event: PointerEvent) => {
      if (event.pointerType === 'pen') cancel();
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const unsubscribe = window.surfaceDesktop?.onNativePen?.((sample) => {
      native = sample;
      if (!sample.inRange || !sample.barrel) {
        clear();
        return;
      }
      if (sample.contact) return; // Tip interaction is handled only by DOM input, once.
      const element = document.elementFromPoint(sample.x, sample.y);
      if (
        !element?.closest('.canvas-container') ||
        document.querySelector('[aria-modal="true"],.pen-tool-wheel')
      ) {
        clear();
        return;
      }
      setPage(
        element.closest<HTMLElement>('[data-page-id]')?.dataset.pageId ?? fallbackPage.current,
      );
      hoverAt(sample.x, sample.y);
    });
    for (const name of ['pointermove', 'pointerdown', 'pointerup'] as const)
      window.addEventListener(name, pointer, true);
    window.addEventListener('pointerout', leave, true);
    window.addEventListener('pointercancel', cancelled, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      unsubscribe?.();
      cancel();
      for (const name of ['pointermove', 'pointerdown', 'pointerup'] as const)
        window.removeEventListener(name, pointer, true);
      window.removeEventListener('pointerout', leave, true);
      window.removeEventListener('pointercancel', cancelled, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [fallbackPage]);
}
