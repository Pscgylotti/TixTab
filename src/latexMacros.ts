export type LatexMacros = Record<string, string>;
const storageKey = 'surfacetab.latexMacros.v1';
export function parseMacros(text: string): LatexMacros {
  let value: unknown;
  if (!text.trim() || text.trim().startsWith('{')) value = JSON.parse(text.trim() || '{}');
  else {
    const macros: LatexMacros = {};
    let at = 0;
    const space = () => {
      while (/\s/.test(text[at] ?? '') && at < text.length) at++;
    };
    const group = () => {
      space();
      if (text[at++] !== '{') throw new Error('命令定义需要成对的花括号');
      const start = at;
      let depth = 1;
      while (at < text.length) {
        const c = text[at++];
        if (c === '\\' && /[{}%]/.test(text[at] ?? '')) {
          at++;
          continue;
        }
        if (c === '{') depth++;
        if (c === '}' && --depth === 0) return text.slice(start, at - 1);
      }
      throw new Error('命令定义的花括号不完整');
    };
    while (at < text.length) {
      space();
      if (at === text.length) break;
      if (text[at] === '%') {
        const end = text.indexOf('\n', at);
        at = end < 0 ? text.length : end + 1;
        continue;
      }
      const command = /^(\\(?:newcommand|renewcommand|providecommand))\*?/.exec(text.slice(at));
      if (!command)
        throw new Error('支持 \\newcommand、\\renewcommand、\\providecommand 或 JSON 命令表');
      at += command[0].length;
      const key = group();
      space();
      if (text[at] === '[') {
        const count = /^\[([0-9])\]/.exec(text.slice(at));
        if (!count) throw new Error('参数数量须为 0–9');
        at += count[0].length;
      }
      const expansion = group();
      macros[key] = expansion;
    }
    value = macros;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('请输入命令与替换内容组成的 JSON 对象');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('最多保存 100 个命令');
  for (const [key, expansion] of entries) {
    if (!/^\\[a-zA-Z]+$/.test(key) || typeof expansion !== 'string' || expansion.length > 2000)
      throw new Error('命令名须为反斜杠加英文字母，替换内容须为不超过 2000 字符的字符串');
  }
  return Object.fromEntries(entries);
}
export function formatMacros(macros: LatexMacros) {
  return Object.entries(macros)
    .map(([key, expansion]) => {
      const args = Math.max(0, ...[...expansion.matchAll(/#([1-9])/g)].map((m) => Number(m[1])));
      return `\\newcommand{${key}}${args ? `[${args}]` : ''}{${expansion}}`;
    })
    .join('\n');
}
export function loadMacros(): LatexMacros {
  try {
    return parseMacros(localStorage.getItem(storageKey) ?? '{}');
  } catch {
    return {};
  }
}
export function saveMacros(macros: LatexMacros) {
  localStorage.setItem(storageKey, JSON.stringify(macros));
}
