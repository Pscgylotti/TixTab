import { useState } from 'react';
import { NotebookPen, Plus, Trash2, Eye, EyeOff, Check, X } from 'lucide-react';
import AnchoredPopover from './AnchoredPopover';
import { MAX_SCRATCH_PAPERS, scratchPaperName, type ScratchPaper } from './scratchPaper';
import { t, useLocale } from './i18n';
export default function ScratchPanel({
  papers,
  selected,
  enabled,
  hiddenPdf,
  disabled,
  onToggle,
  onCreate,
  onSelect,
  onRename,
  onColor,
  onClear,
  onHide,
}: {
  papers: ScratchPaper[];
  selected?: string;
  enabled: boolean;
  hiddenPdf: boolean;
  disabled: boolean;
  onToggle: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onColor: (color: string) => void;
  onClear: () => void;
  onHide: () => void;
}) {
  useLocale();
  const [anchor, setAnchor] = useState<DOMRect | null>(null),
    [confirm, setConfirm] = useState(false);
  const active = papers.find((p) => p.id === selected) ?? papers[0];
  return (
    <>
      <button
        aria-label={t('草稿')}
        title={t('草稿纸')}
        aria-expanded={!!anchor}
        className={enabled ? 'active' : ''}
        disabled={disabled}
        onClick={(e) => {
          setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
          setConfirm(false);
        }}
      >
        <NotebookPen size={19} />
        <span>{t('草稿')}</span>
      </button>
      {anchor && (
        <AnchoredPopover
          anchor={anchor}
          label={t('草稿纸')}
          width={280}
          className="scratch-popover"
          onClose={() => setAnchor(null)}
        >
          <div className="scratch-panel">
            <header>
              <strong>
                <NotebookPen size={16} />
                {t('草稿纸')} <span>{papers.length}/10</span>
              </strong>
              <button aria-label={t('关闭草稿面板')} onClick={() => setAnchor(null)}>
                <X size={15} />
              </button>
            </header>
            <div className="row scratch-mode-controls">
              <button className={enabled ? 'active' : 'primary'} onClick={onToggle}>
                {t(enabled ? '退出草稿模式' : '进入草稿模式')}
              </button>
              <button
                aria-label={t(hiddenPdf ? '显示原 PDF' : '隐藏原 PDF')}
                title={t(hiddenPdf ? '显示原 PDF' : '隐藏原 PDF')}
                disabled={!enabled}
                onClick={onHide}
              >
                {hiddenPdf ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
            </div>
            <div className="scratch-paper-list">
              {papers.map((p) => (
                <div
                  className={p.id === active?.id ? 'active' : ''}
                  key={p.id}
                  onPointerDown={() => {
                    if (p.id !== active?.id) onSelect(p.id);
                  }}
                >
                  <button
                    aria-label={t('选择{0}', scratchPaperName(p))}
                    aria-pressed={p.id === active?.id}
                    onClick={() => {
                      onSelect(p.id);
                      setConfirm(false);
                    }}
                  >
                    {p.id === active?.id ? <Check size={15} /> : <NotebookPen size={15} />}
                  </button>
                  <input
                    aria-label={t('重命名{0}', scratchPaperName(p))}
                    value={scratchPaperName(p)}
                    maxLength={80}
                    onChange={(e) => onRename(p.id, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="row scratch-paper-actions">
              <button disabled={papers.length >= MAX_SCRATCH_PAPERS} onClick={onCreate}>
                <Plus size={15} />
                {t('新建草稿纸')}
              </button>
              <label className="scratch-color">
                {t('背景')}
                <input
                  type="color"
                  aria-label={t('草稿背景颜色')}
                  value={active?.page.paperColor ?? '#ffffff'}
                  disabled={!active}
                  onChange={(e) => onColor(e.target.value)}
                />
              </label>
            </div>
            <button className="scratch-clear" disabled={!active} onClick={() => setConfirm(true)}>
              <Trash2 size={15} />
              {t('清空当前草稿纸')}
            </button>
            {confirm && (
              <div className="scratch-clear-confirm">
                <span>{t('清空笔迹和对象？可撤销。')}</span>
                <div className="row">
                  <button onClick={() => setConfirm(false)}>{t('取消')}</button>
                  <button
                    onClick={() => {
                      onClear();
                      setConfirm(false);
                    }}
                  >
                    {t('确认清空')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </AnchoredPopover>
      )}
    </>
  );
}
