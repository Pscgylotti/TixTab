import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from './pdfTypes';
import type { Page } from './model';
import type { WorkspaceView } from './workspaceStore';
import PdfSurface from './PdfSurface';
import ReadingView from './ReadingView';
import { t } from './i18n';
import './presentation.css';
import { NavigationContext } from './DocumentNavigator';
import { scoreNoteAt, scoreViewportIndex, useScoreCursor } from './musicTransport';

const noop = () => {};
export default function PresentationView({
  pages,
  pdf,
  mode,
  start,
  fullscreen,
  onClose,
}: {
  pages: Page[];
  pdf: PDFDocumentProxy | null;
  mode: WorkspaceView['mode'];
  start: number;
  fullscreen: Promise<() => Promise<void>>;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(start);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [turn, setTurn] = useState({ serial: 0, direction: 1 });
  const [liveZoom, setLiveZoom] = useState<number | null>(null);
  const cursor = useScoreCursor();
  const current = useRef(index);
  current.current = index;
  const close = useRef(onClose);
  close.current = onClose;
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const pointers = useRef(new Set<number>());
  const tap = useRef<{ time: number; x: number; y: number } | null>(null);
  const navigate = (direction: number) => {
    const target = current.current + direction * (mode === 'dual' ? 2 : 1);
    const next = target >= pages.length ? current.current : Math.max(0, target);
    if (next === current.current) return;
    current.current = next;
    setTurn((v) => ({ serial: v.serial + 1, direction }));
    setIndex(next);
  };
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const seekAt = (clientX: number, clientY: number) => {
    if (!cursor.seek) return;
    for (const layer of root.current?.querySelectorAll<SVGSVGElement>('.music-score-layer') ?? []) {
      const box = layer.getBoundingClientRect();
      if (
        !box.width ||
        !box.height ||
        clientX < box.left ||
        clientX > box.right ||
        clientY < box.top ||
        clientY > box.bottom
      )
        continue;
      const page = pages.find((p) => p.id === layer.dataset.scorePageId);
      if (!page?.score) continue;
      const note = scoreNoteAt(
        page.score,
        (clientX - box.left) / box.width,
        (clientY - box.top) / box.height,
      );
      if (note) {
        cursor.seek(page.id, note.beat, note.id);
        return;
      }
    }
  };
  useEffect(() => {
    if (!cursor.seek) return;
    const at = pages.findIndex((p) => p.id === cursor.pageId);
    if (at < 0) return;
    const next = scoreViewportIndex(mode, current.current, at);
    if (next === current.current) return;
    const direction = next > current.current ? 1 : -1;
    current.current = next;
    if (mode !== 'continuous') setTurn((v) => ({ serial: v.serial + 1, direction }));
    setIndex(next);
  }, [cursor.pageId, cursor.seek, pages, mode]);
  useLayoutEffect(() => {
    const app = document.getElementById('root');
    const wasInert = app?.inert;
    const focus = document.activeElement as HTMLElement | null;
    if (app) app.inert = true;
    document.body.classList.add('presentation-active');
    root.current?.focus();
    const observer = new ResizeObserver(([entry]) =>
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(root.current!);
    return () => {
      observer.disconnect();
      document.body.classList.remove('presentation-active');
      if (app) app.inert = wasInert ?? false;
      focus?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let ready = false;
    void fullscreen.then(() => {
      ready = true;
    });
    const changed = (active: boolean) => {
      if (ready && !active) close.current();
    };
    const off = window.surfaceDesktop?.onFullscreen(changed);
    const exit = () => close.current();
    window.addEventListener('tixtab-exit-presentation', exit);
    const browserChanged = () => changed(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', browserChanged);
    return () => {
      off?.();
      window.removeEventListener('tixtab-exit-presentation', exit);
      document.removeEventListener('fullscreenchange', browserChanged);
      void fullscreen.then((release) => release()).catch(() => {});
    };
  }, [fullscreen]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest('.music-player-presentation') &&
        !['Escape', 'F11'].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape' || event.key === 'F11') close.current();
      else if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
        if (mode === 'continuous')
          root.current
            ?.querySelector('.reading-view')
            ?.scrollBy({ top: viewport.height * 0.85, behavior: 'smooth' });
        else navigateRef.current(1);
      } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
        if (mode === 'continuous')
          root.current
            ?.querySelector('.reading-view')
            ?.scrollBy({ top: -viewport.height * 0.85, behavior: 'smooth' });
        else navigateRef.current(-1);
      } else if (mode === 'continuous' && ['ArrowUp', 'ArrowDown'].includes(event.key))
        root.current
          ?.querySelector('.reading-view')
          ?.scrollBy({ top: event.key === 'ArrowDown' ? 80 : -80 });
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
    };
  }, [mode, viewport.height]);
  // Fit each spread, including mixed sizes and the final unpaired page.
  const shown = mode === 'dual' ? pages.slice(index, index + 2) : [pages[index]];
  const width =
    mode === 'continuous'
      ? pages.reduce((max, p) => Math.max(max, p.width), 0)
      : shown.reduce((sum, p) => sum + p.width, 0);
  const height = Math.max(...shown.map((p) => p.height));
  const fitZoom =
    mode === 'continuous'
      ? (viewport.width - 24) / width
      : Math.min(
          (viewport.width - 24 - (shown.length - 1) * 16) / width,
          (viewport.height - 24) / height,
        );
  const zoom = liveZoom ?? fitZoom;
  const widthFits = width * zoom + (shown.length - 1) * 16 <= viewport.width;
  const wheelPaging = useRef(false);
  wheelPaging.current = mode !== 'continuous' && widthFits;
  useEffect(() => {
    const el = root.current!;
    let last = -Infinity,
      x = 0,
      y = 0,
      turned = false;
    let axis: 'horizontal' | 'vertical' | null = null;
    const wheel = (event: WheelEvent) => {
      // Pinch zoom and panning a magnified page stay with the PDF viewport.
      if (!wheelPaging.current || event.ctrlKey || event.metaKey) {
        last = -Infinity;
        return;
      }
      const now = performance.now();
      if (now - last > 200) {
        x = y = 0;
        turned = false;
        axis = null;
      }
      last = now;
      const unit = event.deltaMode === 1 ? 16 : 1;
      x += event.deltaX * (event.deltaMode === 2 ? el.clientWidth : unit);
      y += event.deltaY * (event.deltaMode === 2 ? el.clientHeight : unit);
      if (!axis && Math.hypot(x, y) >= 8)
        axis = Math.abs(x) > Math.abs(y) * 1.4 ? 'horizontal' : 'vertical';
      if (axis === 'vertical' || (!axis && Math.abs(x) <= Math.abs(y) * 1.4)) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep consuming the momentum tail, so one swipe turns only one spread.
      if (!turned && Math.abs(x) >= 60) {
        turned = true;
        navigateRef.current(x > 0 ? 1 : -1);
      }
    };
    el.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', wheel, true);
  }, []);
  useLayoutEffect(() => setLiveZoom(null), [viewport.width, viewport.height]);
  useLayoutEffect(() => {
    if (mode !== 'continuous') setLiveZoom(null);
  }, [turn.serial, mode]);
  useLayoutEffect(() => {
    if (
      !turn.serial ||
      mode === 'continuous' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const stage = root.current?.querySelector('.presentation-stage');
    const animation = stage?.animate(
      [
        {
          opacity: 0.35,
          translate: `${turn.direction * Math.min(100, viewport.width * 0.12)}px 0`,
        },
        { opacity: 1, translate: '0 0' },
      ],
      { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
    return () => animation?.cancel();
  }, [turn, mode]);
  return createPortal(
    <div
      ref={root}
      className="presentation-view"
      role="dialog"
      aria-modal="true"
      aria-label={t('展示全屏，双击退出')}
      tabIndex={-1}
      data-mode={mode}
      data-page-index={index}
      data-view-zoom={zoom}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={() => close.current()}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        pointers.current.add(e.pointerId);
        if (pointers.current.size !== 1) {
          gesture.current = null;
          tap.current = null;
          return;
        }
        gesture.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          moved: false,
        };
      }}
      onPointerMoveCapture={(e) => {
        const g = gesture.current;
        if (!g || g.id !== e.pointerId) return;
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 10) g.moved = true;
      }}
      onPointerUpCapture={(e) => {
        pointers.current.delete(e.pointerId);
        const g = gesture.current;
        gesture.current = null;
        if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x,
          dy = e.clientY - g.y;
        if (
          mode !== 'continuous' &&
          widthFits &&
          Math.abs(dx) >= 45 &&
          Math.abs(dx) > Math.abs(dy) * 1.4
        ) {
          tap.current = null;
          navigate(dx < 0 ? 1 : -1);
        } else if (!g.moved && Math.hypot(dx, dy) <= 10) {
          // The read-only page keeps pointer events disabled. Hit-test after
          // a completed tap so a swipe or pinch never seeks the score.
          seekAt(e.clientX, e.clientY);
          if (e.pointerType === 'mouse') return;
          const previous = tap.current;
          if (
            previous &&
            performance.now() - previous.time < 350 &&
            Math.hypot(previous.x - e.clientX, previous.y - e.clientY) < 30
          )
            close.current();
          else tap.current = { time: performance.now(), x: e.clientX, y: e.clientY };
        } else tap.current = null;
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        gesture.current = null;
        tap.current = null;
      }}
      onLostPointerCapture={(e) => {
        pointers.current.delete(e.pointerId);
        if (gesture.current?.id === e.pointerId) gesture.current = null;
      }}
    >
      <div className="presentation-stage">
        <NavigationContext.Provider value={null}>
          {mode === 'single' ? (
            <PdfSurface
              centerWhenFits
              page={pages[index]}
              pdf={pdf}
              tool="hand"
              editableActive={false}
              color="#000000"
              size={1}
              zoom={zoom}
              resetView={turn.serial}
              setZoom={setLiveZoom}
              onChange={noop}
              onDiagnostic={noop}
              onRender={noop}
              onContext={noop}
              onEditObject={noop}
              focusObjectId={null}
            />
          ) : (
            <ReadingView
              presentation
              pages={pages}
              pdf={pdf}
              mode={mode}
              index={index}
              tool="hand"
              editableActive={false}
              color="#000000"
              size={1}
              zoom={zoom}
              resetView={turn.serial}
              setZoom={setLiveZoom}
              onChange={noop}
              onDiagnostic={noop}
              onContext={noop}
              onEditObject={noop}
              focusObjectId={null}
              onEdit={noop}
              onPageChange={setIndex}
            />
          )}
        </NavigationContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
