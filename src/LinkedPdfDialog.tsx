import { useEffect, useRef } from 'react';
import { X, FilePlus2, FolderOpen } from 'lucide-react';
import { t, useLocale } from './i18n';
import type { WorkspaceDocument } from './workspaceStore';
import './linkedPdf.css';

export default function LinkedPdfDialog({
  name,
  documents,
  activeId,
  onChoose,
}: {
  name: string;
  documents: WorkspaceDocument[];
  activeId: string;
  onChoose: (id: string | null) => void;
}) {
  const locale = useLocale(),
    root = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('.linked-pdf-choice')?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="modal-scrim linked-pdf-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onChoose(null);
        }
        if (e.key === 'Tab') {
          const buttons = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('button'));
          if (e.shiftKey && document.activeElement === buttons[0]) {
            e.preventDefault();
            buttons.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === buttons.at(-1)) {
            e.preventDefault();
            buttons[0]?.focus();
          }
        }
      }}
    >
      <section
        className="modal linked-pdf-modal"
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={t('选择关联工程')}
      >
        <header>
          <div>
            <h2>{t('选择关联工程')}</h2>
            <p>{name}</p>
          </div>
          <button aria-label={t('取消')} onClick={() => onChoose(null)}>
            <X size={20} />
          </button>
        </header>
        <p>{t('找到 {0} 个关联工程，选择要继续的版本。', documents.length)}</p>
        <div className="linked-pdf-list">
          {documents.map((d) => (
            <button key={d.id} className="linked-pdf-choice" onClick={() => onChoose(d.id)}>
              <span className="linked-pdf-preview">
                {d.preview && <img src={d.preview} alt="" loading="lazy" />}
              </span>
              <span className="linked-pdf-info">
                <strong>{d.name}</strong>
                <small>
                  {t('{0} 页', d.pageIds.length)} · {t('上次阅读：第 {0} 页', d.view.index + 1)}
                  {d.id === activeId ? ` · ${t('当前文档')}` : ''}
                </small>
                <small>{t('最后修改：{0}', new Date(d.updatedAt).toLocaleString(locale))}</small>
                <small>{t('创建时间：{0}', new Date(d.createdAt).toLocaleString(locale))}</small>
                {d.batch && (
                  <small>
                    {t('连续批注组')} · {d.documentName}
                  </small>
                )}
                {d.sourcePath && (
                  <small className="linked-pdf-path" title={d.sourcePath}>
                    {d.sourcePath}
                  </small>
                )}
                <small>{t('工程编号：{0}', d.id.slice(0, 8))}</small>
              </span>
              <FolderOpen size={20} />
            </button>
          ))}
        </div>
        <footer>
          <button onClick={() => onChoose(null)}>{t('取消')}</button>
          <button onClick={() => onChoose('new')}>
            <FilePlus2 size={18} />
            {t('从原 PDF 新建工程')}
          </button>
        </footer>
      </section>
    </div>
  );
}
