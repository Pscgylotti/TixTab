import { useSyncExternalStore } from 'react';
import english from './locales/en.json';
export type Locale = 'zh-CN' | 'en';
const dictionary: Record<string, string> = english;
const listeners = new Set<() => void>(),
  cache = new Map<string, string>();
let locale: Locale = 'zh-CN';
try {
  if (localStorage.getItem('surfacetab.locale') === 'en') locale = 'en';
} catch {
  /* Defaults also work without storage. */
}
const reverse = new Map(Object.entries(dictionary).map(([zh, en]) => [en, zh]));
function pattern(text: string) {
  const keys: number[] = [];
  let last = 0,
    source = '^';
  for (const match of text.matchAll(/\{(\d+)\}/g)) {
    source += text.slice(last, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)';
    keys.push(Number(match[1]));
    last = match.index! + match[0].length;
  }
  source += text.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  return { regex: new RegExp(source), keys };
}
const patterns = Object.entries(dictionary)
  .filter(([zh]) => /\{\d+\}/.test(zh))
  .map(([zh, en]) => ({ zh, en, forward: pattern(zh), reverse: pattern(en) }));
function format(text: string, args: unknown[]) {
  return text.replace(/\{(\d+)\}/g, (match, i) =>
    args[Number(i)] === undefined ? match : String(args[Number(i)]),
  );
}
/** UI strings only. PDF text, names, LaTeX and translated content stay unchanged. */
export function t(text: string, ...args: unknown[]): string {
  if (args.length)
    return format(locale === 'en' ? (dictionary[text] ?? text) : (reverse.get(text) ?? text), args);
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  let result = locale === 'en' ? (dictionary[text] ?? text) : (reverse.get(text) ?? text);
  if (result === text)
    for (const p of patterns) {
      const side = locale === 'en' ? p.forward : p.reverse,
        match = side.regex.exec(text);
      if (match) {
        const values: unknown[] = [];
        side.keys.forEach((key, i) => {
          values[key] = match[i + 1];
        });
        result = format(locale === 'en' ? p.en : p.zh, values);
        break;
      }
    }
  if (cache.size > 1000) cache.clear();
  cache.set(text, result);
  return result;
}
export function getLocale() {
  return locale;
}
export function setLocale(next: Locale) {
  if ((next !== 'en' && next !== 'zh-CN') || next === locale) return;
  locale = next;
  cache.clear();
  try {
    localStorage.setItem('surfacetab.locale', next);
  } catch {
    /* Session language remains available. */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
export function useLocale() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getLocale);
}
if (typeof document !== 'undefined') document.documentElement.lang = locale;
