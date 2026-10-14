import { useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { Undo2, Redo2 } from 'lucide-react';

/** Mirror only the caret; the native textarea still owns editing, selection and IME. */
export default function LatexSource({
  value,
  position,
  disabled,
  onChange,
  onPosition,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  value: string;
  position: number;
  disabled: boolean;
  onChange: (value: string, position: number, kind?: string) => void;
  onPosition: (position: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [viewport, setViewport] = useState({ width: 0, x: 0, y: 0 });
  const sync = () => {
    const el = field.current;
    if (el)
      setViewport((current) =>
        current.width === el.clientWidth &&
        current.x === el.scrollLeft &&
        current.y === el.scrollTop
          ? current
          : { width: el.clientWidth, x: el.scrollLeft, y: el.scrollTop },
      );
  };
  useLayoutEffect(() => {
    if (field.current && field.current.selectionStart !== position)
      field.current.setSelectionRange(position, position);
    sync();
  }, [value, position]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(sync);
    if (field.current) observer.observe(field.current);
    return () => observer.disconnect();
  }, []);
  const before = value.slice(0, position);
  const row = before.split('\n').length,
    column = before.length - before.lastIndexOf('\n');
  return (
    <>
      <div className="latex-source-header">
        <label className="field-label" htmlFor="latex">
          {t('LaTeX · 可直接修改')}
        </label>
        <small>{t('插入位置：第 {0} 行，第 {1} 列', row, column)}</small>
        <div className="latex-history-actions">
          <button
            className="icon-button"
            aria-label={t('撤销 LaTeX 编辑')}
            title={`${t('撤销 LaTeX 编辑')} (Ctrl+Z)`}
            disabled={disabled || !canUndo}
            onPointerDown={(e) => e.preventDefault()}
            onClick={onUndo}
          >
            <Undo2 size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={t('重做 LaTeX 编辑')}
            title={`${t('重做 LaTeX 编辑')} (Ctrl+Y / Ctrl+Shift+Z)`}
            disabled={disabled || !canRedo}
            onPointerDown={(e) => e.preventDefault()}
            onClick={onRedo}
          >
            <Redo2 size={15} />
          </button>
        </div>
      </div>
      <div className="latex-source">
        <textarea
          id="latex"
          ref={field}
          disabled={disabled}
          value={value}
          spellCheck={false}
          onChange={(e) => {
            const kind = (e.nativeEvent as InputEvent).inputType;
            onChange(
              e.target.value,
              e.target.selectionStart,
              ['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(kind)
                ? kind
                : '',
            );
            onPosition(e.target.selectionStart);
          }}
          onSelect={(e) => onPosition(e.currentTarget.selectionStart)}
          onBlur={(e) => onPosition(e.currentTarget.selectionStart)}
          onPointerUp={(e) => onPosition(e.currentTarget.selectionStart)}
          onKeyUp={(e) => onPosition(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
            const key = e.key.toLowerCase();
            if (key === 'z' || key === 'y') {
              e.preventDefault();
              e.stopPropagation();
              key === 'y' || e.shiftKey ? onRedo() : onUndo();
            }
          }}
          onBeforeInput={(e) => {
            const type = (e.nativeEvent as InputEvent).inputType;
            if (type === 'historyUndo' || type === 'historyRedo') {
              e.preventDefault();
              e.stopPropagation();
              type === 'historyUndo' ? onUndo() : onRedo();
            }
          }}
          onScroll={sync}
          placeholder={t('例如：\\\\int_0^1 x^2 \\\\, dx = \\\\frac{1}{3}')}
        />
        <div className="latex-caret-viewport" aria-hidden="true">
          <div
            className="latex-caret-mirror"
            style={{
              width: viewport.width,
              transform: `translate(${-viewport.x}px, ${-viewport.y}px)`,
            }}
          >
            {before}
            <span className="latex-persistent-caret" data-position={position} />
            {value.slice(position)}
            {'\u200b'}
          </div>
        </div>
      </div>
    </>
  );
}
