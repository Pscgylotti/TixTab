export type Locale = 'zh-CN' | 'en';

/** Keep an explicit choice; otherwise negotiate the first supported system language. */
export function initialLocale(saved: unknown, languages: readonly unknown[]): Locale {
  if (saved === 'en' || saved === 'zh-CN') return saved;
  for (const language of languages) {
    if (typeof language !== 'string') continue;
    const primary = language.toLowerCase().replaceAll('_', '-').split('-')[0];
    if (primary === 'en') return 'en';
    if (primary === 'zh') return 'zh-CN';
  }
  return 'en';
}
