import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Languages } from 'lucide-react';
import { inkTools } from './inkTools';
import { t, useLocale } from './i18n';
import type { Tool } from './model';
import './penToolWheel.css';
export default function PenToolWheel({
  x,
  y,
  tool,
  onSelect,
  onClose,
  onText,
}: {
  x: number;
  y: number;
  tool: Tool;
  onSelect: (tool: Tool) => void;
  onClose: () => void;
  onText?: () => void;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const update = () =>
      setPosition({
        left: Math.max(8, Math.min(x - 132, innerWidth - 272)),
        top: Math.max(8, Math.min(y - 132, innerHeight - 272)),
      });
    update();
    addEventListener('resize', update);
    return () => removeEventListener('resize', update);
  }, [x, y]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const buttons = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') || [],
        );
        const index = buttons.findIndex((b) => b === document.activeElement),
          direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
        buttons[(index + direction + buttons.length) % buttons.length]?.focus();
      }
      if (event.key === 'Tab') {
        const buttons = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>('button') || [],
        );
        const index = buttons.findIndex((b) => b === document.activeElement);
        event.preventDefault();
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    addEventListener('keydown', key, true);
    const hide = () => {
      if (document.hidden) close.current();
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', hide);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="pen-wheel-scrim"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={root}
        className="pen-tool-wheel"
        role="menu"
        aria-label={t('笔侧键工具环')}
        style={position}
      >
        {inkTools.map(({ id, label, icon: Icon }, index) => {
          const angle = (index * Math.PI * 2) / inkTools.length - Math.PI / 2;
          return (
            <button
              key={id}
              className={`pen-wheel-tool${tool === id ? ' active' : ''}`}
              role="menuitemradio"
              aria-checked={tool === id}
              aria-label={t(label)}
              title={t(label)}
              style={{ left: 132 + 92 * Math.cos(angle), top: 132 + 92 * Math.sin(angle) }}
              onClick={() => onSelect(id)}
            >
              <Icon size={20} />
              <small>{t(label)}</small>
              {id === 'ballpoint' && <i />}
            </button>
          );
        })}
        <button
          className="pen-wheel-center"
          aria-label={t(onText ? '划词工具' : '关闭工具环')}
          onClick={onText || onClose}
        >
          {onText ? <Languages size={22} /> : <X size={22} />}
          <small>{t(onText ? '划词工具' : '关闭')}</small>
        </button>
      </div>
    </div>,
    document.body,
  );
}
