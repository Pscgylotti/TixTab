import { t as tr, useLocale } from './i18n';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Page } from './model';
import PageThumbnail from './PageThumbnail';
import { itemAt, makeLayout, visibleRange } from './virtualLayout';
import { useScrollViewport } from './useScrollViewport';
export default function PageList({
  pages,
  pdf,
  index,
  onSelect,
  onMove,
  onDelete,
}: {
  pages: Page[];
  pdf: PDFDocumentProxy | null;
  index: number;
  onSelect: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onDelete: (i: number) => void;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    suppressClick = useRef(0);
  const contact = useRef<{
      id: number;
      from: number;
      to: number;
      x: number;
      y: number;
      lastY: number;
      held: boolean;
      moved: boolean;
    } | null>(null),
    autoFrame = useRef(0);
  const [viewport, measure] = useScrollViewport(root);
  const thumbWidth = root.current
    ? parseFloat(getComputedStyle(root.current).getPropertyValue('--thumbnail-width')) || 120
    : 120;
  const layout = useMemo(
    () => makeLayout(pages.map((p) => (thumbWidth * p.height) / p.width + 32)),
    [pages, thumbWidth],
  );
  const geometry = useRef(layout);
  geometry.current = layout;
  const range = visibleRange(layout, viewport.top - 4, viewport.height, 300);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null),
    [menu, setMenu] = useState<number | null>(null);
  const cleanup = () => {
    clearTimeout(timer.current);
    cancelAnimationFrame(autoFrame.current);
    autoFrame.current = 0;
    contact.current = null;
    setDrag(null);
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(autoFrame.current);
    },
    [],
  );
  useEffect(() => {
    setMenu(null);
    cleanup();
  }, [pages]);
  useLayoutEffect(() => {
    const el = root.current!;
    if (contact.current) return;
    const top = layout.offsets[index] + 4,
      bottom = layout.offsets[index + 1] + 4;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    measure();
  }, [index, pages[index]?.id]);
  const dragTarget = () => {
    const c = contact.current,
      el = root.current;
    if (!c || !el) return;
    c.to = itemAt(geometry.current, el.scrollTop + c.lastY - el.getBoundingClientRect().top - 4);
    setDrag((old) => (old?.from === c.from && old.to === c.to ? old : { from: c.from, to: c.to }));
  };
  const autoScroll = () => {
    autoFrame.current = 0;
    const c = contact.current,
      el = root.current;
    if (!c?.held || !c.moved || !el) return;
    const bounds = el.getBoundingClientRect(),
      speed =
        c.lastY < bounds.top + 35
          ? -Math.min(18, (bounds.top + 35 - c.lastY) / 2)
          : c.lastY > bounds.bottom - 35
            ? Math.min(18, (c.lastY - bounds.bottom + 35) / 2)
            : 0;
    if (!speed) return;
    const previous = el.scrollTop;
    el.scrollTop += speed;
    if (el.scrollTop !== previous) {
      dragTarget();
      autoFrame.current = requestAnimationFrame(autoScroll);
    }
  };
  const down = (e: ReactPointerEvent, from: number) => {
    if (e.button !== 0) return;
    setMenu(null);
    cleanup();
    const c = {
      id: e.pointerId,
      from,
      to: from,
      x: e.clientX,
      y: e.clientY,
      lastY: e.clientY,
      held: false,
      moved: false,
    };
    contact.current = c;
    root.current!.setPointerCapture(e.pointerId);
    timer.current = setTimeout(() => {
      if (contact.current !== c) return;
      c.held = true;
      suppressClick.current = performance.now() + 800;
      setMenu(from);
    }, 450);
  };
  const move = (e: ReactPointerEvent) => {
    const c = contact.current;
    if (!c || c.id !== e.pointerId) return;
    const distance = Math.hypot(e.clientX - c.x, e.clientY - c.y),
      el = root.current!;
    if (!c.held) {
      if (distance > 8) {
        clearTimeout(timer.current);
        c.moved = true;
        suppressClick.current = performance.now() + 800;
        if (e.pointerType !== 'mouse') el.scrollTop -= e.clientY - c.lastY;
      }
    } else if (distance > 6) {
      e.preventDefault();
      c.moved = true;
      setMenu(null);
      c.lastY = e.clientY;
      dragTarget();
      if (!autoFrame.current) autoFrame.current = requestAnimationFrame(autoScroll);
    }
    c.lastY = e.clientY;
  };
  const end = (e: ReactPointerEvent, cancel = false) => {
    const c = contact.current;
    if (!c || c.id !== e.pointerId) return;
    if (c.held || c.moved) suppressClick.current = performance.now() + 800;
    if (!cancel && !c.held && !c.moved) {
      suppressClick.current = performance.now() + 800;
      onSelect(c.from);
    }
    if (!cancel && c.held && c.moved && c.from !== c.to) onMove(c.from, c.to);
    cleanup();
  };
  return (
    <div
      className="page-list"
      ref={root}
      onPointerMove={move}
      onPointerUp={(e) => end(e)}
      onPointerCancel={(e) => end(e, true)}
      onLostPointerCapture={(e) => end(e, true)}
    >
      <div className="virtual-thumbnail-layout" style={{ height: layout.total }}>
        {pages.slice(range.start, range.end).map((p, n) => {
          const i = range.start + n;
          return (
            <div
              className="page-list-item"
              key={p.id}
              style={{
                position: 'absolute',
                top: layout.offsets[i],
                left: 0,
                right: 0,
                height: layout.offsets[i + 1] - layout.offsets[i],
              }}
            >
              <button
                className={`page-card ${i === index ? 'selected' : ''} ${drag?.from === i ? 'dragging' : ''} ${drag?.to === i ? 'drop-target' : ''}`}
                aria-label={tr('第 {0} 页', i + 1)}
                data-page-index={i}
                draggable={false}
                onPointerDown={(e) => down(e, i)}
                onClick={() => {
                  if (performance.now() > suppressClick.current) onSelect(i);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  cleanup();
                  setMenu(i);
                }}
              >
                <PageThumbnail page={p} pdf={pdf} />
                <div className="page-caption">
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  <span>
                    {p.sourceIndex === null ? tr('空白页') : tr('原稿 {0}', p.sourceIndex + 1)}
                  </span>
                  {i === index && <span className="selected-dot" />}
                </div>
              </button>
              {menu === i && (
                <div
                  className="page-manage"
                  role="menu"
                  aria-label={tr('管理第 {0} 页', i + 1)}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button role="menuitem" disabled={!i} onClick={() => onMove(i, i - 1)}>
                    {tr('上移')}
                  </button>
                  <button
                    role="menuitem"
                    disabled={i === pages.length - 1}
                    onClick={() => onMove(i, i + 1)}
                  >
                    {tr('下移')}
                  </button>
                  <button
                    role="menuitem"
                    disabled={pages.length === 1}
                    onClick={() => {
                      setMenu(null);
                      onDelete(i);
                    }}
                  >
                    {tr('删除')}
                  </button>
                  <button role="menuitem" onClick={() => setMenu(null)}>
                    {tr('关闭')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
