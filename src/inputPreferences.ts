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
