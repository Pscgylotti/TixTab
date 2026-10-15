import { useSyncExternalStore } from 'react';

const key = 'surfacetab.nativeKeyboard';
const changed = 'surfacetab-native-keyboard';
const enabled = () => localStorage.getItem(key) === 'true';
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  window.addEventListener(changed, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener('storage', storage);
  };
}
export function setNativeKeyboard(enabled: boolean) {
  localStorage.setItem(key, String(enabled));
  window.dispatchEvent(new Event(changed));
}
export function useNativeKeyboard() {
  return useSyncExternalStore(subscribe, enabled, () => false);
}
