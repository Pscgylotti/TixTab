import { useSyncExternalStore } from 'react';

export const DEFAULT_UI_SCALE = 2;
const key = 'tixtab.uiScale';
const listeners = new Set<() => void>();
let initialized = false;

export function normalizeUiScale(value: number) {
  return Number.isFinite(value)
    ? Math.round(Math.min(4, Math.max(0.5, value)) * 10) / 10
    : DEFAULT_UI_SCALE;
}

function savedScale() {
  try {
    const saved = localStorage.getItem(key);
    return saved?.trim() ? normalizeUiScale(Number(saved)) : DEFAULT_UI_SCALE;
  } catch {
    return DEFAULT_UI_SCALE;
  }
}
let scale = savedScale();

export function uiScaleAvailable() {
  return typeof window !== 'undefined' && typeof window.surfaceDesktop?.setUiScale === 'function';
}

function apply(value: number) {
  try {
    return window.surfaceDesktop?.setUiScale?.(value) === true;
  } catch {
    return false;
  }
}

export function setUiScale(value: number) {
  if (!Number.isFinite(value)) return false;
  const next = normalizeUiScale(value);
  if (!apply(next)) return false;
  scale = next;
  try {
    localStorage.setItem(key, String(scale));
  } catch {}
  listeners.forEach((fn) => fn());
  return true;
}

export function useUiScale() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => scale,
  );
}

export function initializeUiScale() {
  if (initialized) return;
  initialized = true;
  apply(scale);
  // Same-origin windows share Chromium zoom and the persisted preference.
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    const next = savedScale();
    if (next === scale || !apply(next)) return;
    scale = next;
    listeners.forEach((fn) => fn());
  });
}
