import { useSyncExternalStore } from 'react';
import type { WritingHand } from './selectionPlacement';
let hand: WritingHand = 'right';
try {
  if (localStorage.getItem('surfacetab.writingHand') === 'left') hand = 'left';
} catch {
  /* Session preference still works. */
}
const listeners = new Set<() => void>();
export function useWritingHand() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => hand,
  );
}
export function setWritingHand(value: WritingHand) {
  if (!['left', 'right'].includes(value) || value === hand) return;
  hand = value;
  try {
    localStorage.setItem('surfacetab.writingHand', value);
  } catch {
    /* Session preference still works. */
  }
  listeners.forEach((fn) => fn());
}

let touchMode = false;
try {
  touchMode = localStorage.getItem('tixtab.touchMode') === 'true';
} catch {
  /* Session only. */
}
const touchListeners = new Set<() => void>();
export const getTouchMode = () => touchMode;
export function subscribeTouchMode(fn: () => void) {
  touchListeners.add(fn);
  return () => {
    touchListeners.delete(fn);
  };
}
export function useTouchMode() {
  return useSyncExternalStore(subscribeTouchMode, getTouchMode);
}
export function setTouchMode(enabled: boolean) {
  if (enabled === touchMode) return;
  touchMode = enabled;
  try {
    localStorage.setItem('tixtab.touchMode', String(enabled));
  } catch {
    /* Session only. */
  }
  touchListeners.forEach((fn) => fn());
}
