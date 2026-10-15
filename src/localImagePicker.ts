import { useSyncExternalStore } from 'react';
import type { CorrectionTarget } from './documentCorrection';
let picker: ((target: CorrectionTarget | null) => void) | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
export function setLocalImagePicker(next: typeof picker) {
  picker = next;
  changed();
}
export function pickLocalImage(target: CorrectionTarget | null) {
  const callback = picker;
  picker = null;
  changed();
  callback?.(target);
}
export function useLocalImagePicker() {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    () => !!picker,
  );
}
