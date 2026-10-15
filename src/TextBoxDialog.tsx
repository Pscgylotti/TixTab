import { useEffect, useRef, useState } from 'react';
import { Type, X } from 'lucide-react';
import { t, useLocale } from './i18n';
import { type TextBox } from './model';
import TextMarkdown from './TextMarkdown';
import { defaultTextBox, textBoxImage } from './textBox';
import type { ImportedImage } from './svgImport';
export default function TextBoxDialog({
  initial,
  onClose,
  onInsert,
}: {
  initial?: TextBox;
  onClose: () => void;
  onInsert: (image: ImportedImage) => void;
}) {
  useLocale();
  const [box, setBox] = useState<TextBox>(() => (initial ? { ...initial } : { ...defaultTextBox }));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState(false);
  const root = useRef<HTMLElement>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector('textarea')?.focus();
    return () => {
      mounted.current = false;
      previous?.isConnected && previous.focus({ preventScroll: true });
    };
  }, []);
  const insert = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const image = await textBoxImage(box);
      if (mounted.current) onInsert(image);
    } catch (e) {
      if (mounted.current)
        setError(
          t(
            e instanceof Error && e.message === 'text-large'
              ? '文本较长，请拆分为多个文本框。'
              : '无法生成文本框，请检查内容后重试。',
          ),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="modal-scrim">
      <section
        className="modal text-box-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(initial ? '编辑文本框' : '插入文本框')}
        ref={root}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!busy) onClose();
          }
          if (event.key === 'Tab') {
            const controls = Array.from(
              root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea'),
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>
            <Type size={18} />
            {t(initial ? '编辑文本框' : '插入文本框')}
          </h2>
          <button
            className="icon-button"
            aria-label={t('关闭文本框编辑')}
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="text-box-format" role="group" aria-label={t('文本格式')}>
          <div className="text-box-format-switch">
            <button
              className={box.format !== 'markdown' ? 'active' : ''}
              aria-pressed={box.format !== 'markdown'}
              onClick={() => setBox({ ...box, format: 'plain' })}
            >
              {t('纯文本')}
            </button>
            <button
              className={box.format === 'markdown' ? 'active' : ''}
              aria-pressed={box.format === 'markdown'}
              onClick={() => setBox({ ...box, format: 'markdown' })}
            >
              Markdown
            </button>
          </div>
          <button
            className={preview ? 'active' : ''}
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {t('预览')}
          </button>
        </div>
        {box.format !== 'markdown' && (
          <div className="text-box-options">
            <label>
              {t('字号')}
              <input
                aria-label={t('文本框字号')}
                type="number"
                min={8}
                max={72}
                value={box.fontSize}
                onChange={(e) => setBox({ ...box, fontSize: Number(e.target.value) })}
              />
            </label>
            <label>
              {t('颜色')}
              <input
                aria-label={t('文本框颜色')}
                type="color"
                value={box.color}
                onChange={(e) => setBox({ ...box, color: e.target.value })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={box.bold}
                onChange={(e) => setBox({ ...box, bold: e.target.checked })}
              />
              {t('粗体')}
            </label>
          </div>
        )}
        <div className={`text-box-editors ${preview ? 'with-preview' : ''}`}>
          <textarea
            aria-label={t('文本框内容')}
            maxLength={10000}
            value={box.content}
            placeholder={t('输入文字，支持换行…')}
            onChange={(e) => setBox({ ...box, content: e.target.value })}
            style={{
              fontSize: Math.max(8, Math.min(72, box.fontSize)) || 18,
              fontWeight: box.bold ? 600 : 400,
            }}
          />
          {preview && (
            <div className="text-box-preview" aria-label={t('文本框预览')}>
              {box.format === 'markdown' ? (
                <TextMarkdown box={box} />
              ) : (
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    fontSize: box.fontSize,
                    fontWeight: box.bold ? 600 : 400,
                    color: box.color,
                  }}
                >
                  {box.content}
                </div>
              )}
            </div>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        <footer>
          <span>{t('插入后可使用对象工具移动、缩放或再次编辑。')}</span>
          <button
            className="primary"
            disabled={
              busy ||
              !box.content.trim() ||
              box.fontSize < 8 ||
              box.fontSize > 72 ||
              !Number.isFinite(box.fontSize)
            }
            onClick={() => void insert()}
          >
            {t(busy ? '正在生成…' : initial ? '保存文本框' : '插入当前页')}
          </button>
        </footer>
      </section>
    </div>
  );
}

import './textBox.css';
