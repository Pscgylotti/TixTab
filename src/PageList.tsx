import { t as tr, useLocale } from './i18n';
import { createPortal } from 'react-dom';
import type { PageAction } from './pageOperations';
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
import { insertionAt, insertionDestination, makeLayout, visibleRange } from './virtualLayout';
import { useScrollViewport } from './useScrollViewport';
import { ScrollVelocity, inertiaStep } from './scrollInertia';
export default function PageList({
  pages,
  pdf,
  index,
  onSelect,
  onMove,
  onDelete,
  onDuplicate,
  onCopyPage,
  onPastePage,
  hasCopiedPage,
  onClearClipboard,
  onEditPages,
}: {
  pages: Page[];
  pdf: PDFDocumentProxy | null;
  index: number;
  onSelect: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onDelete: (i: number, anchor: DOMRect) => void;
  onDuplicate: (i: number) => void;
  onCopyPage?: (i: number) => void;
  onPastePage?: (i: number) => void;
  hasCopiedPage?: boolean;
  onClearClipboard?: () => void;
  onEditPages?: (action: PageAction, index: number) => void;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    suppressClick = useRef(0);
  const velocity = useRef(new ScrollVelocity()),
    kineticFrame = useRef(0);
  const stopKinetic = () => {
    cancelAnimationFrame(kineticFrame.current);
    kineticFrame.current = 0;
    velocity.current.reset();
  };
  const startKinetic = () => {
    let speed = velocity.current.release(performance.now()),
      last = performance.now();
    velocity.current.reset();
    if (Math.abs(speed.y) < 0.035) return;
    const frame = (time: number) => {
      kineticFrame.current = 0;
      const el = root.current;
      if (!el || contact.current) return;
      const step = inertiaStep(speed, time - last),
        old = el.scrollTop;
      el.scrollTop += step.dy;
      speed = step.velocity;
      last = time;
      if (!step.done && Math.abs(el.scrollTop - old) > 0.01)
        kineticFrame.current = requestAnimationFrame(frame);
    };
    kineticFrame.current = requestAnimationFrame(frame);
  };
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
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (menu === null) return;
    const r = root.current?.querySelector(`[data-page-index="${menu}"]`)?.getBoundingClientRect();
    if (r)
      setMenuPosition({
        left: Math.min(window.innerWidth - 188, Math.max(8, r.right - 170)),
        top: Math.max(8, Math.min(window.innerHeight - 500, r.top + 25)),
      });
    const close = (event: Event) => {
      if (!(event.target as HTMLElement).closest('.page-actions-menu,.page-card')) setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  const cleanup = () => {
    clearTimeout(timer.current);
    cancelAnimationFrame(autoFrame.current);
    autoFrame.current = 0;
    const pointer = contact.current?.id;
    contact.current = null;
    if (pointer !== undefined && root.current?.hasPointerCapture(pointer))
      root.current.releasePointerCapture(pointer);
    setDrag(null);
  };
  useEffect(() => {
    const cancel = () => {
      stopKinetic();
      if (contact.current) suppressClick.current = performance.now() + 800;
      cleanup();
      setMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!contact.current && menuRef.current === null)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(autoFrame.current);
      stopKinetic();
    },
    [],
  );
  useEffect(() => {
    stopKinetic();
    setMenu(null);
    cleanup();
  }, [pages]);
  useLayoutEffect(() => {
    const el = root.current!;
    if (contact.current) return;
    stopKinetic();
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
    c.to = insertionAt(
      geometry.current,
      el.scrollTop + c.lastY - el.getBoundingClientRect().top - 4,
    );
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
    stopKinetic();
    if (e.pointerType === 'touch') velocity.current.add(e.clientX, e.clientY, performance.now());
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
      stopKinetic();
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
      if (e.pointerType === 'touch') velocity.current.add(e.clientX, e.clientY, performance.now());
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
    if (!cancel && c.held && c.moved) {
      const destination = insertionDestination(c.from, c.to);
      if (c.from !== destination) onMove(c.from, destination);
    }
    const coast = !cancel && !c.held && c.moved && e.pointerType === 'touch';
    cleanup();
    if (coast) startKinetic();
    else velocity.current.reset();
  };
  return (
    <div
      className="page-list"
      onKeyDown={(event) => {
        if (
          !(event.ctrlKey || event.metaKey) ||
          event.altKey ||
          event.shiftKey ||
          !['c', 'v'].includes(event.key.toLowerCase())
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const value = (event.target as HTMLElement)
          .closest('[data-page-index]')
          ?.getAttribute('data-page-index');
        const at = value === null || value === undefined ? index : Number(value);
        if (!Number.isInteger(at) || !pages[at]) return;
        if (event.key.toLowerCase() === 'c') onCopyPage?.(at);
        else if (hasCopiedPage) onPastePage?.(at);
      }}
      ref={root}
      onPointerDownCapture={(e) => {
        if (contact.current && contact.current.id !== e.pointerId) {
          stopKinetic();
          cleanup();
        } else if (!contact.current) stopKinetic();
      }}
      onWheel={stopKinetic}
      onPointerMove={move}
      onPointerUp={(e) => end(e)}
      onPointerCancel={(e) => end(e, true)}
      onLostPointerCapture={(e) => end(e, true)}
    >
      <div className="virtual-thumbnail-layout" style={{ height: layout.total }}>
        {drag && (
          <div
            className="page-insertion-line"
            data-insertion-index={drag.to}
            aria-hidden="true"
            style={{ top: Math.max(0, Math.min(layout.total - 2, layout.offsets[drag.to])) }}
          />
        )}
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
                className={`page-card ${i === index ? 'selected' : ''} ${drag?.from === i ? 'dragging' : ''}`}
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
              {menu === i &&
                createPortal(
                  <div
                    className="page-actions-menu"
                    style={menuPosition}
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
                      onClick={(event) => {
                        setMenu(null);
                        onDelete(i, event.currentTarget.getBoundingClientRect());
                      }}
                    >
                      {tr('删除')}
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        onDuplicate(i);
                      }}
                    >
                      {tr('复制页面')}
                    </button>
                    {onCopyPage && (
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          onCopyPage(i);
                        }}
                      >
                        {tr('复制页面到剪贴板')}
                      </button>
                    )}
                    {onPastePage && (
                      <button
                        role="menuitem"
                        disabled={!hasCopiedPage}
                        onClick={() => {
                          setMenu(null);
                          onPastePage(i);
                        }}
                      >
                        {tr('粘贴页面')}
                      </button>
                    )}
                    {onClearClipboard && (
                      <button
                        role="menuitem"
                        disabled={!hasCopiedPage}
                        onClick={() => {
                          setMenu(null);
                          onClearClipboard();
                        }}
                      >
                        {tr('清除页面剪贴板')}
                      </button>
                    )}
                    {onEditPages &&
                      (['rotate', 'crop', 'split'] as const).map((action) => (
                        <button
                          key={action}
                          role="menuitem"
                          onClick={() => {
                            setMenu(null);
                            onEditPages(action, i);
                          }}
                        >
                          {tr(
                            { rotate: '旋转页面', crop: '裁剪页面', split: '拆分 / 提取 PDF' }[
                              action
                            ],
                          )}
                        </button>
                      ))}
                    <button role="menuitem" onClick={() => setMenu(null)}>
                      {tr('关闭')}
                    </button>
                  </div>,
                  document.body,
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
