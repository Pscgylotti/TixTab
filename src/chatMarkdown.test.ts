import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatMarkdown from './ChatMarkdown';
import { normalizeChatMath, safeChatLink } from './chatMarkdownText';

vi.mock('./i18n', () => ({ t: (text: string) => text, useLocale: () => 'zh-CN' }));

describe('chat answer formatting', () => {
  it('normalizes complete TeX delimiters and preserves unfinished streamed math', () => {
    expect(normalizeChatMath(String.raw`Inline \(x^2\), display \[x=y\], unfinished \(z`)).toBe(
      'Inline $x^2$, display \n\n$$\nx=y\n$$\n\n, unfinished \\(z',
    );
  });
  it('preserves fenced, inline, indented and unfinished code verbatim', () => {
    for (const code of [
      String.raw`\(x\)`,
      '```latex\n\\[x\\]\n```',
      '~~~latex\n\\[x\\]\n~~~',
      '    \\(x\\)',
      '```latex\n\\(x\\)',
      '`\\(x\\)',
      '``\\(x\\)``',
    ]) {
      const source = code.startsWith('\\') ? '`' + code + '`' : code;
      expect(normalizeChatMath(source)).toBe(source);
    }
    expect(normalizeChatMath(String.raw`\\(escaped)`)).toBe(String.raw`\\(escaped)`);
  });
  it('renders headings, emphasis, nested lists, tables, quotes and code', () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        text: '# Heading\n\n**Bold** and *italic*\n\n- One\n  - Nested\n\n> Quote\n\n| A | B |\n|---|---|\n| x | y |\n\n```python\nprint("hello")\n```',
      }),
    );
    for (const expected of [
      '<h1>Heading</h1>',
      '<strong>Bold</strong>',
      '<em>italic</em>',
      '<ul>',
      '<blockquote>',
      '<table>',
      'chat-code-block',
      'language-python',
      '复制代码',
    ])
      expect(html).toContain(expected);
  });
  it('renders inline and multiline TeX as accessible KaTeX math', () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        text: String.raw`The score is \(s_t(x)\).
\[
\begin{aligned}a&=b\\c&=d\end{aligned}
\]
`,
      }),
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).toContain('<math');
    expect(html).not.toContain('katex-error');
  });
  it('does not execute HTML, unsafe links or automatic remote images', () => {
    const html = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        text: '<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![Remote figure](https://example.com/track.png)\n\n```html\n<script>example</script>\n```',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;example&lt;/script&gt;');
    expect(html).toContain('href="https://example.com/track.png"');
  });
  it('allows only explicit web URLs without embedded credentials', () => {
    for (const value of [
      'javascript:alert(1)',
      'file:///C:/test',
      'data:text/html,x',
      'https://secret@example.com/a',
      '/relative',
      '//example.com',
    ])
      expect(safeChatLink(value)).toBe('');
    expect(safeChatLink('https://example.com/paper?q=x')).toBe('https://example.com/paper?q=x');
  });
});
