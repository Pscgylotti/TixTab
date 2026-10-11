import {
  Children,
  isValidElement,
  memo,
  useDeferredValue,
  useMemo,
  useState,
  type ReactNode,
  type ComponentProps,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { copyText } from './clipboard';
import { chatRequest } from './chatgpt';
import { t, useLocale } from './i18n';
import { normalizeChatMath, safeChatLink } from './chatMarkdownText';
import 'katex/dist/katex.min.css';

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  const code = Children.toArray(children).find(isValidElement);
  const props = isValidElement<{ className?: string; children?: ReactNode }>(code)
    ? code.props
    : {};
  const language = /language-([^\s]+)/.exec(props.className || '')?.[1] || 'code';
  const text = Children.toArray(props.children).join('').replace(/\n$/, '');
  return (
    <div className="chat-code-block">
      <div className="chat-code-heading">
        <span>{language}</span>
        <button
          aria-label={t('复制代码')}
          onClick={() =>
            void copyText(text)
              .then(() => {
                setCopied(true);
                setError(false);
              })
              .catch(() => setError(true))
          }
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{t(error ? '复制失败' : copied ? '已复制' : '复制代码')}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function ChatLink({ href, children, ...props }: ComponentProps<'a'>) {
  const [error, setError] = useState(false),
    url = safeChatLink(href || '');
  if (!url) return <span>{children}</span>;
  return (
    <>
      <a
        {...props}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (window.surfaceDesktop?.chatgpt) {
            event.preventDefault();
            void chatRequest({ action: 'open-link', url }).catch(() => setError(true));
          }
        }}
      >
        {children}
      </a>
      {error && <small role="status">{t('无法打开链接')}</small>}
    </>
  );
}
const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ node: _node, ...props }) => <ChatLink {...props} />,
  // A model-provided image URL is a link, never an automatic remote download.
  img: ({ src, alt }) => (
    <ChatLink href={typeof src === 'string' ? src : undefined}>{alt || t('图片')}</ChatLink>
  ),
  table: ({ children }) => (
    <div className="chat-table-scroll" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};
const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20 }],
];
export default memo(function ChatMarkdown({ text }: { text: string }) {
  useLocale();
  const deferred = useDeferredValue(text),
    content = useMemo(() => normalizeChatMath(deferred), [deferred]);
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        skipHtml
        urlTransform={safeChatLink}
      >
        {content}
      </Markdown>
    </div>
  );
});
