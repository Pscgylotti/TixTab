import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Delete, X } from 'lucide-react';
import { t as tr } from './i18n';
import './pageJump.css';
export default function PageJump({
  index,
  total,
  onJump,
}: {
  index: number;
  total: number;
  onJump: (index: number) => void;
}) {
  const [mode, setMode] = useState<'keyboard' | 'touch' | null>(null);
  const [draft, setDraft] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null),
    pointer = useRef('mouse'),
    fresh = useRef(true);
  const digit = (value: number) => {
    const replace = fresh.current;
    setDraft((d) => ((replace ? '' : d) + value).slice(0, String(total).length + 1));
    fresh.current = false;
  };
  const close = () => {
    setMode(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const valid = /^\d+$/.test(draft) && Number(draft) >= 1 && Number(draft) <= total;
  const go = () => {
    if (valid) {
      onJump(Number(draft) - 1);
      close();
    }
  };
  useLayoutEffect(() => {
    if (!mode) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect(),
        p = panel.current?.getBoundingClientRect();
      if (r && p)
        setPosition({
          left: Math.max(8, Math.min(innerWidth - p.width - 8, r.left + r.width / 2 - p.width / 2)),
          top: Math.max(8, r.top - p.height - 8),
        });
    };
    place();
    if (mode === 'keyboard') {
      input.current?.focus();
      input.current?.select();
    }
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [mode]);
  useEffect(() => {
    if (!mode) return;
    const down = (e: PointerEvent) => {
      if (
        e.target instanceof Node &&
        !panel.current?.contains(e.target) &&
        !trigger.current?.contains(e.target)
      )
        setMode(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const hide = () => setMode(null);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', hide);
    };
  }, [mode]);
  return (
    <>
      <span className="page-number-slot">
        <button
          ref={trigger}
          className="page-jump-trigger"
          aria-label={tr('跳转到页码')}
          title={tr('跳转到页码')}
          aria-expanded={!!mode}
          aria-haspopup="dialog"
          onPointerDown={(e) => {
            pointer.current = e.pointerType;
          }}
          onClick={(e) => {
            if (mode) {
              close();
              return;
            }
            setDraft(String(index + 1));
            fresh.current = true;
            setMode(e.detail === 0 || pointer.current === 'mouse' ? 'keyboard' : 'touch');
          }}
        >
          <span>
            {index + 1} <i>/ {total}</i>
          </span>
        </button>
      </span>
      {mode &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={tr('跳转到页码')}
            className="page-jump-panel"
            style={position}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <header>
              <strong>{tr('跳转到页码')}</strong>
              <button className="icon-button" aria-label={tr('关闭')} onClick={close}>
                <X size={16} />
              </button>
            </header>
            <div className="page-jump-entry">
              {mode === 'keyboard' ? (
                <input
                  ref={input}
                  aria-label={tr('目标页码')}
                  type="text"
                  inputMode="numeric"
                  value={draft}
                  onChange={(e) =>
                    setDraft(e.target.value.replace(/\D/g, '').slice(0, String(total).length + 1))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      go();
                    }
                  }}
                />
              ) : (
                <output aria-label={tr('目标页码')}>{draft || '—'}</output>
              )}
              <span>/ {total}</span>
              {mode === 'keyboard' && (
                <button
                  className="primary icon-button"
                  aria-label={tr('跳转')}
                  disabled={!valid}
                  onClick={go}
                >
                  <ArrowRight size={17} />
                </button>
              )}
            </div>
            {mode === 'touch' && (
              <div className="page-jump-numpad" aria-label={tr('数字键盘')}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => (
                  <button key={value} onClick={() => digit(value)}>
                    {value}
                  </button>
                ))}
                <button
                  aria-label={tr('退格')}
                  onClick={() => {
                    fresh.current = false;
                    setDraft((d) => d.slice(0, -1));
                  }}
                >
                  <Delete size={19} />
                </button>
                <button onClick={() => digit(0)}>0</button>
                <button className="primary" aria-label={tr('跳转')} disabled={!valid} onClick={go}>
                  <ArrowRight size={19} />
                </button>
              </div>
            )}
            {!valid && draft && <small role="status">{tr('请输入 1–{0} 之间的页码', total)}</small>}
          </div>,
          document.body,
        )}
    </>
  );
}
