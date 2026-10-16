import { useSyncExternalStore } from 'react';

export const translationLanguages = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
];
const key = 'surfacetab.recentTranslationTargets';
const event = 'surfacetab-translation-targets';
function snapshot() {
  try {
    return localStorage.getItem(key) ?? '[]';
  } catch {
    return '[]';
  }
}
function parse(raw: string): string[] {
  try {
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values)
      ? [
          ...new Set(values.filter((id) => translationLanguages.some((item) => item.id === id))),
        ].slice(0, 3)
      : [];
  } catch {
    return [];
  }
}
function subscribe(listener: () => void) {
  window.addEventListener(event, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(event, listener);
    window.removeEventListener('storage', listener);
  };
}
export const recentTranslationTargets = () => parse(snapshot());
export function rememberTranslationTarget(target: string) {
  if (!translationLanguages.some((item) => item.id === target)) return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify(
        [target, ...recentTranslationTargets().filter((id) => id !== target)].slice(0, 3),
      ),
    );
    window.dispatchEvent(new Event(event));
  } catch {
    /* Translation remains usable without persistent preferences. */
  }
}
export function useRecentTranslationTargets() {
  return parse(useSyncExternalStore(subscribe, snapshot, () => '[]'));
}
