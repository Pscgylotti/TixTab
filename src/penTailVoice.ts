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
