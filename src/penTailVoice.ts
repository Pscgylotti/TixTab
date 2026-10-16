import { useSyncExternalStore } from 'react';
const key = 'tixtab.penTailVoice',
  event = 'tixtab-pen-tail-voice-setting';
const get = () => localStorage.getItem(key) === 'true';
export function setPenTailVoice(enabled: boolean) {
  localStorage.setItem(key, String(enabled));
  window.dispatchEvent(new Event(event));
}
export function usePenTailVoice() {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener(event, fn);
      window.addEventListener('storage', fn);
      return () => {
        window.removeEventListener(event, fn);
        window.removeEventListener('storage', fn);
      };
    },
    get,
    () => false,
  );
}
export function createTailGesture(single: () => void, double: () => void, delay = 500) {
  let pending: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    clearTimeout(pending);
    pending = undefined;
  };
  return {
    press(kind: 'press' | 'send' = 'press') {
      if (kind === 'send' || pending !== undefined) {
        dispose();
        double();
      } else
        pending = setTimeout(() => {
          pending = undefined;
          single();
        }, delay);
    },
    dispose,
  };
}
