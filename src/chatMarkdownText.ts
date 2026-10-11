/** Normalize ChatGPT's TeX delimiters without rewriting code examples. */
export function normalizeChatMath(source: string): string {
  let out = '',
    i = 0,
    fence = '';
  while (i < source.length) {
    if (i === 0 || source[i - 1] === '\n') {
      const end = source.indexOf('\n', i),
        line = source.slice(i, end < 0 ? source.length : end);
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence || marker || /^(?: {4}|\t)/.test(line)) {
        if (marker) {
          if (!fence) fence = marker;
          else if (
            marker[0] === fence[0] &&
            marker.length >= fence.length &&
            line.slice(line.indexOf(marker) + marker.length).trim() === ''
          )
            fence = '';
        }
        out += line + (end < 0 ? '' : '\n');
        i = end < 0 ? source.length : end + 1;
        continue;
      }
    }
    if (source[i] === '`') {
      let n = 1;
      while (source[i + n] === '`') n++;
      const marker = '`'.repeat(n),
        end = source.indexOf(marker, i + n);
      const next = end < 0 ? source.length : end + n;
      out += source.slice(i, next);
      i = next;
      continue;
    }
    if (source[i] === '\\' && source[i + 1] === '\\') {
      out += '\\\\';
      i += 2;
      continue;
    }
    if (source[i] === '\\' && (source[i + 1] === '(' || source[i + 1] === '[')) {
      const display = source[i + 1] === '[',
        end = source.indexOf(display ? '\\]' : '\\)', i + 2);
      if (end >= 0) {
        const math = source.slice(i + 2, end);
        out += display ? `\n\n$$\n${math.trim()}\n$$\n\n` : `$${math}$`;
        i = end + 2;
        continue;
      }
    }
    out += source[i++];
  }
  return out;
}

export function safeChatLink(value: string): string {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
