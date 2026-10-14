import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Palette, X } from 'lucide-react';
import { t as tr } from './i18n';

export const inkColors = ['#23324d', '#4775db', '#e46d65', '#51a993', '#c19c49', '#9676c8'];
const valid = (value: unknown): value is string =>
  typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
export function savedInkColor() {
  try {
    const c = localStorage.getItem('surfacetab.inkColor');
    return valid(c) ? c : inkColors[0];
  } catch {
    return inkColors[0];
  }
}
function savedPalette(): string[] {
  try {
    const a: unknown = JSON.parse(localStorage.getItem('surfacetab.inkPalette') || '[]');
    return Array.isArray(a)
      ? [...new Set(a.filter(valid).map((c) => c.toLowerCase()))].slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

export default function InkColors({
  color,
  onChange,
  compact = false,
}: {
  color: string;
  onChange: (color: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(color),
    [palette, setPalette] = useState(savedPalette);
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 100 });
  useEffect(() => {
    try {
      localStorage.setItem('surfacetab.inkColor', color);
      localStorage.setItem('surfacetab.inkPalette', JSON.stringify(palette));
    } catch {
      /* Session-only when storage is unavailable. */
    }
  }, [color, palette]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (
        !panel.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const swatch = (c: string) => (
    <button
      key={c}
      className={`color-swatch ${color === c ? 'selected' : ''}`}
      title={c}
      aria-label={tr('颜色 {0}', c)}
      aria-pressed={color === c}
      style={{ '--swatch': c } as React.CSSProperties}
      onClick={() => {
        onChange(c);
        setDraft(c);
        if (compact) setOpen(false);
      }}
    />
  );
  return (
    <div className={`colors${compact ? ' colors-compact' : ''}`}>
      {!compact && inkColors.map(swatch)}
      <button
        ref={trigger}
        className="icon-button custom-color-trigger"
        aria-label={tr(compact ? '笔触颜色' : '自定义笔触颜色')}
        title={tr(compact ? '笔触颜色' : '自定义笔触颜色')}
        aria-expanded={open}
        style={{ '--swatch': color } as React.CSSProperties}
        onClick={() => {
          const r = trigger.current!.getBoundingClientRect();
          setPosition({
            left: Math.max(8, Math.min(r.left, innerWidth - 296)),
            top: Math.max(8, Math.min(r.bottom + 8, innerHeight - 340)),
          });
          setDraft(color);
          setOpen((v) => !v);
        }}
      >
        {compact ? (
          <span className="selected-ink-color" aria-hidden="true" />
        ) : (
          <>
            <Palette size={18} />
            <i />
          </>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="ink-color-panel"
            role="dialog"
            aria-label={tr('自定义笔触颜色')}
            style={position}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <header>
              <strong>{tr('自定义笔触颜色')}</strong>
              <button
                className="icon-button"
                aria-label={tr('关闭颜色设置')}
                onClick={() => setOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            {compact && (
              <div className="preset-ink-colors" role="group" aria-label={tr('预设颜色')}>
                {inkColors.map(swatch)}
              </div>
            )}
            <label className="ink-color-input">
              {tr('选择颜色')}
              <input
                type="color"
                aria-label={tr('选择颜色')}
                value={valid(draft) ? draft : color}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <label className="ink-color-input">
              HEX
              <input
                aria-label={tr('十六进制颜色')}
                value={draft}
                maxLength={7}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && valid(draft)) {
                    onChange(draft.toLowerCase());
                    setOpen(false);
                  }
                }}
              />
            </label>
            <div className="row">
              <button
                disabled={!valid(draft)}
                className="primary"
                onClick={() => {
                  onChange(draft.toLowerCase());
                  setOpen(false);
                }}
              >
                {tr('应用颜色')}
              </button>
              <button
                disabled={
                  !valid(draft) || palette.includes(draft.toLowerCase()) || palette.length >= 12
                }
                onClick={() => {
                  const c = draft.toLowerCase();
                  setPalette((a) => [...a, c]);
                  onChange(c);
                }}
              >
                {tr('保存常用颜色')}
              </button>
            </div>
            <p>{tr('常用颜色（最多 12 个）')}</p>
            <div className="saved-ink-colors">
              {palette.map((c) => (
                <div key={c}>
                  {swatch(c)}
                  <button
                    aria-label={tr('移除颜色 {0}', c)}
                    onClick={() => setPalette((a) => a.filter((x) => x !== c))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
