import { useLayoutEffect, useRef } from 'react';
import { t, useLocale } from './i18n';
const key = 'tixtab.sidebarWidth';
export default function SidebarResizer() {
  useLocale();
  const handle = useRef<HTMLDivElement>(null),
    drag = useRef<{ id: number; start: number; width: number; next: number } | null>(null),
    frame = useRef(0);
  const limits = () => ({
    min: 212,
    max: Math.max(212, Math.min(720, innerWidth - 240, innerWidth * 0.65)),
  });
  const apply = (width: number) => {
    const el = handle.current?.parentElement;
    if (!el) return;
    const { min, max } = limits(),
      next = Math.round(Math.max(min, Math.min(max, width)));
    el.style.width = `${next}px`;
    handle.current!.setAttribute('aria-valuenow', String(next));
    handle.current!.setAttribute('aria-valuemax', String(Math.floor(max)));
    return next;
  };
  const save = (width: number) => {
    try {
      localStorage.setItem(key, String(width));
    } catch {}
  };
  useLayoutEffect(() => {
    try {
      const width = Number(localStorage.getItem(key));
      if (width >= 212) apply(width);
    } catch {}
    const resize = () => {
      const el = handle.current?.parentElement;
      if (el?.style.width) apply(parseFloat(el.style.width));
    };
    addEventListener('resize', resize);
    return () => {
      removeEventListener('resize', resize);
      cancelAnimationFrame(frame.current);
    };
  }, []);
  const end = (cancel = false) => {
    const session = drag.current;
    if (!session) return;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const width = apply(cancel ? session.width : session.next);
    if (!cancel && width) save(width);
    drag.current = null;
    handle.current?.parentElement?.classList.remove('sidebar-resizing');
  };
  return (
    <div
      ref={handle}
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label={t('调整侧栏宽度')}
      aria-orientation="vertical"
      aria-valuemin={212}
      aria-valuemax={720}
      aria-valuenow={212}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const width = e.currentTarget.parentElement!.getBoundingClientRect().width;
        drag.current = { id: e.pointerId, start: e.clientX, width, next: width };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.parentElement!.classList.add('sidebar-resizing');
      }}
      onPointerMove={(e) => {
        const session = drag.current;
        if (!session || session.id !== e.pointerId) return;
        session.next = session.width + e.clientX - session.start;
        if (!frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (drag.current) apply(drag.current.next);
          });
      }}
      onPointerUp={() => end()}
      onPointerCancel={() => end(true)}
      onLostPointerCapture={() => end(true)}
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
        e.preventDefault();
        const next = apply(
          e.key === 'Home'
            ? 212
            : handle.current!.parentElement!.getBoundingClientRect().width +
                (e.key === 'ArrowLeft' ? -16 : 16),
        );
        if (next) save(next);
      }}
      onDoubleClick={() => {
        try {
          localStorage.removeItem(key);
        } catch {}
        handle.current!.parentElement!.style.removeProperty('width');
      }}
    />
  );
}
