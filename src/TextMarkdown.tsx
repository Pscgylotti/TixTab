import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TextBox } from './model';
import { t } from './i18n';
import './textMarkdown.css';
const plugins = [remarkGfm];
/** Text objects never fetch remote images or execute embedded HTML. */
export default function TextMarkdown({ box }: { box: TextBox }) {
  return (
    <div
      className="text-markdown"
      style={{ fontSize: box.fontSize, color: box.color, fontWeight: box.bold ? 600 : 400 }}
    >
      <Markdown
        remarkPlugins={plugins}
        skipHtml
        components={{
          a: ({ children }) => <span className="markdown-link">{children}</span>,
          img: ({ alt }) => <span>{alt || t('图片')}</span>,
          input: ({ checked }) => <span>{checked ? '☑' : '☐'}</span>,
        }}
      >
        {box.content}
      </Markdown>
    </div>
  );
}
