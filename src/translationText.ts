/** PDF line wraps are layout, while a blank line is a paragraph boundary. */
export function isLocalTranslationNoop(text: string, target: string): boolean {
  if (!['en', 'zh-CN'].includes(target)) return false;
  const chinese = /[\u4e00-\u9fff]/.test(text);
  return (
    !/\p{L}/u.test(text) ||
    (target === 'en' && !chinese) ||
    (target === 'zh-CN' && chinese && !/[a-zA-Z]{3}/.test(text))
  );
}
export function normalizeTranslationText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00ad[ \t]*\n[ \t]*/g, '')
    .split(/\n[ \t]*\n+/)
    .map((paragraph) =>
      paragraph
        .trim()
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(
          /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：])\n(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：])/gu,
          '$1',
        )
        .replace(/\n/g, ' '),
    )
    .filter(Boolean)
    .join('\n\n')
    .trim();
}
