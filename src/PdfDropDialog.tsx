import { useEffect, useRef, useState } from 'react';
import { t, useLocale } from './i18n';
import { loadPdf } from './pdf';
import { parsePageRange } from './pdfInsertion';
export interface PdfDropChoice {
  mode: 'open' | 'insert';
  pages: number[][];
}

export default function PdfDropDialog({
  files,
  onClose,
  onConfirm,
}: {
  files: File[];
  onClose: () => void;
  onConfirm: (choice: PdfDropChoice) => void;
}) {
  useLocale();
  const [mode, setMode] = useState<'open' | 'insert'>('open');
  const [all, setAll] = useState(true),
    [ranges, setRanges] = useState(files.map(() => ''));
  const [counts, setCounts] = useState<number[] | null>(null),
    [error, setError] = useState('');
  const modal = useRef<HTMLElement>(null);
  useEffect(() => {
    let dead = false;
    void (async () => {
      const values: number[] = [];
      for (const file of files) {
        try {
          const document = await loadPdf(new Uint8Array(await file.arrayBuffer()));
          values.push(document.numPages);
          await document.destroy();
        } catch {
          values.push(0);
        }
        if (dead) return;
      }
      if (!dead) setCounts(values);
    })();
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>('.pdf-drop-cancel')?.focus();
    return () => {
      dead = true;
      previous?.focus();
    };
  }, [files]);
  return (
    <div
      className="modal-scrim pdf-import-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
        if (e.key === 'Tab') {
          const nodes = Array.from(
            modal.current!.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled)',
            ),
          ).filter((el) => el.getClientRects().length);
          const first = nodes[0],
            last = nodes.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        ref={modal}
        role="dialog"
        aria-modal="true"
        aria-label={t('导入 PDF')}
        className="modal small-modal pdf-import-modal"
      >
        <header>
          <h2>{t('如何导入 PDF？')}</h2>
        </header>
        <div className="pdf-import-body">
          <label>
            <input
              type="radio"
              name="pdf-drop-mode"
              checked={mode === 'open'}
              onChange={() => setMode('open')}
            />
            {t('作为新标签页打开')}
          </label>
          <label>
            <input
              type="radio"
              name="pdf-drop-mode"
              checked={mode === 'insert'}
              onChange={() => setMode('insert')}
            />
            {t('插入当前文档的当前页之后')}
          </label>
          {mode === 'insert' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(e) => {
                    setAll(e.target.checked);
                    setError('');
                  }}
                />
                {t('插入全部页面')}
              </label>
              <p className="muted">
                {t('合并会重新保存 PDF，原数字签名将失效；导入页的表单转为静态外观。')}
              </p>
            </>
          )}
          <div className="pdf-import-files">
            {files.map((file, index) => (
              <div key={index}>
                <span>
                  {file.name} ·{' '}
                  {counts
                    ? counts[index]
                      ? t('{0} 页', counts[index])
                      : t('无法读取')
                    : t('正在读取…')}
                </span>
                {mode === 'insert' && !all && (
                  <input
                    aria-label={t('页码范围 · {0}', file.name)}
                    placeholder={t('例如 1-3, 5；留空为全部')}
                    maxLength={2048}
                    value={ranges[index]}
                    onChange={(e) => {
                      setRanges((old) =>
                        old.map((value, at) => (at === index ? e.target.value : value)),
                      );
                      setError('');
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          <p role="alert" className="error">
            {error}
          </p>
          <footer>
            <button className="pdf-drop-cancel" onClick={onClose}>
              {t('取消')}
            </button>
            <button
              className="primary"
              disabled={mode === 'insert' && (!counts || counts.some((n) => !n))}
              onClick={() => {
                try {
                  onConfirm({
                    mode,
                    pages:
                      mode === 'open'
                        ? []
                        : files.map((_, i) => parsePageRange(all ? '' : ranges[i], counts![i])),
                  });
                } catch {
                  setError(t('页码范围无效，请使用 1-3, 5 这样的格式，且不要超过文件页数。'));
                }
              }}
            >
              {t(mode === 'open' ? '打开为新标签页' : '插入页面')}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
