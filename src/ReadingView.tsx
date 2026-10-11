import { MIN_ZOOM, MAX_ZOOM } from './pageFit';
import { useAppearance, renderPolicy, pageRenderScale } from './appearance';
import PdfOriginalImages from './PdfOriginalImages';
import { t as tr, useLocale } from './i18n';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PenLine } from 'lucide-react';
import { PanZoomPointers } from './gestures';
import PdfTextLayer from './PdfTextLayer';
import PdfDetailLayer from './PdfDetailLayer';
import { requestPdfBitmap, renderingCancelled } from './pdfRenderCache';
import { finalInkPath } from './ink';
import { isPicture, type Page } from './model';
import { makeLayout, visibleRange, itemAt } from './virtualLayout';
import { useScrollViewport } from './useScrollViewport';
import { zoomReadingPoint } from './readingZoom';
import { ScrollVelocity, inertiaStep } from './scrollInertia';
const ReadingPage = memo(function ReadingPage({
  page,
  pdf,
  number,
  selectable,
  onEdit,
  width,

  top,
  viewport,
  hand,
}: {
  page: Page;
  pdf: PDFDocumentProxy | null;
  number: number;
  selectable: boolean;
  onEdit: (i: number) => void;
  width: number;

  top?: number;
  viewport: RefObject<HTMLElement | null>;
  hand: boolean;
}) {
  useLocale();
  const { pdfNight } = useAppearance(),
    policy = renderPolicy();
  const root = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    [visible, setVisible] = useState(false),
    [status, setStatus] = useState(tr('等待预览'));
  const scale = width / page.width;
  const [settledWidth, setSettledWidth] = useState(width);
  useEffect(() => {
    const timer = setTimeout(() => setSettledWidth(width), policy.settleMs);
    return () => clearTimeout(timer);
  }, [width, policy.settleMs]);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '300px',
    });
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const c = canvas.current!;
    let dead = false,
      cancel: (() => void) | undefined;
    if (!visible || !pdf || page.sourceIndex === null) {
      c.width = 1;
      c.height = 1;
      return;
    }
    setStatus(tr('加载预览…'));
    const renderScale = pageRenderScale(
      settledWidth / page.width,
      window.devicePixelRatio,
      page.width,
      page.height,
      true,

      policy,
    );
    const lease = requestPdfBitmap(pdf, page.sourceIndex, renderScale, 1, pdfNight);
    cancel = lease.cancel;
    void lease.promise
      .then((bitmap) => {
        if (!dead) {
          c.width = bitmap.width;
          c.height = bitmap.height;
          c.getContext('2d')!.drawImage(bitmap, 0, 0);
          c.dataset.renderedNight = String(pdfNight);
          setStatus(tr('就绪'));
        }
      })
      .catch((e) => {
        if (!dead && !renderingCancelled(e)) setStatus(tr('预览失败'));
      });
    return () => {
      dead = true;
      cancel?.();
    };
  }, [
    pdf,
    page.id,
    visible,
    settledWidth,

    pdfNight,
    policy.readingPixels,
    policy.dpr,
    policy.baseScale,
    policy.sampling,
  ]);
  return (
    <section
      className="reading-card"
      ref={root}
      data-page-id={page.id}
      data-page-index={number - 1}
      style={{
        width,
        ...(top === undefined
          ? {}
          : { position: 'absolute', top, left: '50%', transform: 'translateX(-50%)' }),
      }}
    >
      <div className="reading-page-heading">
        <span>
          {tr('第 {0} 页', number)}
          <small>{page.sourceIndex === null ? tr('空白页') : tr(status)}</small>
        </span>
        <button onClick={() => onEdit(number - 1)}>
          <PenLine size={14} />
          {tr('在此页标注')}
        </button>
      </div>
      <div
        className={`reading-paper paper-${page.sourceIndex === null ? page.paper : 'plain'}`}
        style={{ width, height: page.height * scale }}
      >
        <div
          className={`reading-content ${selectable ? 'selectable' : ''}`}
          data-pdf-night={pdfNight}
          style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
        >
          <canvas className="reading-pdf" ref={canvas} />
          <PdfDetailLayer
            pdf={visible ? pdf : null}
            sourceIndex={page.sourceIndex}
            width={page.width}
            height={page.height}
            zoom={scale}
            baseScale={pageRenderScale(
              scale,
              window.devicePixelRatio,
              page.width,
              page.height,
              true,

              policy,
            )}

            viewport={viewport}
            viewKey={top}
          />
          {visible && (
            <>
              <PdfOriginalImages pdf={pdf} sourceIndex={page.sourceIndex} enabled={hand} />
              {page.images.map((i) => (
                <img
                  key={i.id}
                  src={i.displayData ?? i.data}
                  data-night-ink={!isPicture(i)}
                  alt={
                    i.kind === 'text'
                      ? i.textBox?.content
                      : isPicture(i)
                        ? tr('图片')
                        : i.latex || tr('草图')
                  }
                  style={{
                    position: 'absolute',
                    left: i.x,
                    top: i.y,
                    width: i.width,
                    height: i.height,
                    pointerEvents: 'none',
                  }}
                />
              ))}
              <svg viewBox={`0 0 ${page.width} ${page.height}`} className="reading-ink">
                {page.strokes.map((s) => (
                  <path
                    key={s.id}
                    d={finalInkPath(s)}
                    fill={s.color}
                    opacity={s.tool === 'highlighter' ? 0.28 : s.tool === 'pencil' ? 0.65 : 1}
                  />
                ))}
              </svg>
              {selectable && <PdfTextLayer pdf={pdf} sourceIndex={page.sourceIndex} />}
            </>
          )}
        </div>
      </div>
    </section>
  );
});
export default function ReadingView({
  pages,
  pdf,
  mode,
  index,
  tool,

  zoom,
  setZoom,
  resetView,
  onEdit,
  onPageChange,
}: {
  pages: Page[];
  pdf: PDFDocumentProxy | null;
  mode: 'continuous' | 'dual';
  index: number;
  tool: import('./model').Tool;

  zoom: number;
  setZoom: (zoom: number) => void;
  resetView: number;
  onEdit: (i: number) => void;
  onPageChange: (i: number) => void;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    pointers = useRef(new PanZoomPointers()),
    frame = useRef(0);
  const kinetic = useRef(0),
    velocity = useRef(new ScrollVelocity()),
    touches = useRef(new Set<number>()),
    singleTouch = useRef(false);
  const stopInertia = () => {
    cancelAnimationFrame(kinetic.current);
    kinetic.current = 0;
  };
  const startInertia = (speed: { x: number; y: number }) => {
    stopInertia();
    if (mode !== 'continuous' || Math.hypot(speed.x, speed.y) < 0.12) return;
    let previous = performance.now();
    const tick = (time: number) => {
      const el = root.current;
      if (!el) {
        stopInertia();
        return;
      }
      const delta = inertiaStep(speed, time - previous);
      previous = time;
      const x = el.scrollLeft,
        y = el.scrollTop;
      el.scrollLeft += delta.dx;
      el.scrollTop += delta.dy;
      speed = {
        x: Math.abs(el.scrollLeft - x) < 0.01 ? 0 : delta.velocity.x,
        y: Math.abs(el.scrollTop - y) < 0.01 ? 0 : delta.velocity.y,
      };
      if (delta.done || Math.hypot(speed.x, speed.y) < 0.035) {
        stopInertia();
        return;
      }
      kinetic.current = requestAnimationFrame(tick);
    };
    kinetic.current = requestAnimationFrame(tick);
  };
  const [viewport, measure] = useScrollViewport(root);
  const layout = useMemo(
    () =>
      makeLayout(
        pages.map((page) => page.height * zoom + 25),
        8,
      ),
    [pages, zoom],
  );
  const widest = useMemo(
    () => pages.reduce((width, page) => Math.max(width, page.width), 0),
    [pages],
  );
  const range = visibleRange(
    layout,
    viewport.top - 8,
    viewport.height,
    Math.max(400, viewport.height),
  );
  const observedIndex = useRef<number | null>(null),
    lastReset = useRef(resetView);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const anchor = useRef<{ x: number; y: number; contentX: number; contentY: number } | null>(null);
  const previous = useRef<{
    zoom: number;
    mode: 'continuous' | 'dual';
    index: number;
    pages: Page[];
    width: number;
    left: number;
    top: number;
    height: number;
  } | null>(null);
  const zoomTo = (value: number, clientX: number, clientY: number) => {
    stopInertia();
    const el = root.current!,
      body = content.current!,
      rect = el.getBoundingClientRect();
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    if (next === zoomRef.current) return;
    const x = clientX - rect.left,
      y = clientY - rect.top;
    if (!anchor.current)
      anchor.current = {
        x,
        y,
        contentX: el.scrollLeft + x - body.offsetLeft,
        contentY: el.scrollTop + y - body.offsetTop,
      };
    zoomRef.current = next;
    setZoom(next);
  };
  useLayoutEffect(() => {
    const el = root.current!,
      body = content.current!,
      prev = previous.current;
    if (prev && prev.zoom !== zoom && prev.mode === mode && prev.pages === pages) {
      const a = anchor.current ?? {
        x: prev.width / 2,
        y: prev.height / 2,
        contentX: prev.left + prev.width / 2,
        contentY: prev.top + prev.height / 2,
      };
      const next = zoomReadingPoint(pages, mode, prev.index, prev.width, prev.zoom, zoom, {
        x: a.contentX,
        y: a.contentY,
      });
      el.scrollLeft = body.offsetLeft + next.x - a.x;
      el.scrollTop = body.offsetTop + next.y - a.y;
      measure();
    }
    anchor.current = null;
    previous.current = {
      zoom,
      mode,
      index,
      pages,
      width: el.clientWidth,
      left: el.scrollLeft,
      top: el.scrollTop,
      height: el.clientHeight,
    };
  });
  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const delta = pointers.current.take(),
      el = root.current;
    if (!delta || !el) return;
    if (delta.scale !== 1) zoomTo(zoomRef.current * delta.scale, delta.x, delta.y);
    if (anchor.current) {
      anchor.current.x += delta.dx;
      anchor.current.y += delta.dy;
    } else {
      el.scrollLeft -= delta.dx;
      el.scrollTop -= delta.dy;
    }
  };
  useEffect(() => {
    const el = root.current!;
    const wheel = (e: WheelEvent) => {
      stopInertia();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
      }
    };
    const visibility = () => {
      if (document.hidden) stopInertia();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', stopInertia);
    const unsubscribe = window.surfaceDesktop?.onWindowVisibility?.((visible) => {
      if (!visible) stopInertia();
    });
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', wheel);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', stopInertia);
      unsubscribe?.();
      cancelAnimationFrame(frame.current);
      stopInertia();
    };
  }, []);
  useLayoutEffect(() => {
    const el = root.current!;
    if (mode === 'continuous' && observedIndex.current === index && lastReset.current === resetView)
      return;
    lastReset.current = resetView;
    observedIndex.current = index;
    stopInertia();
    velocity.current.reset();
    touches.current.clear();
    singleTouch.current = false;
    pointers.current.reset();
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    if (mode === 'continuous') el.scrollTop = 8 + (layout.offsets[index] ?? 0);
    else el.scrollTop = 0;
    measure();
  }, [index, mode, resetView, pages[index]?.id]);
  useEffect(() => {
    if (mode !== 'continuous' || !viewport.height) return;
    // A layout jump can precede the viewport state update. Never publish the old position.
    const el = root.current;
    if (!el || Math.abs(el.scrollTop - viewport.top) > 0.5 || el.clientHeight !== viewport.height)
      return;
    const inset =
      parseFloat(
        (root.current
          ? getComputedStyle(root.current).getPropertyValue('--page-controls-inset')
          : '') || '0',
      ) || 0;
    const next = itemAt(
      layout,
      Math.max(0, viewport.top - 8 + Math.max(1, viewport.height - inset) * 0.4),
    );
    if (next !== observedIndex.current) {
      observedIndex.current = next;
      onPageChange(next);
    }
  }, [viewport.top, viewport.height, layout, mode, onPageChange]);
  const down = (e: ReactPointerEvent) => {
    stopInertia();
    if (
      (e.target as HTMLElement).closest('button,a') ||
      !(e.pointerType === 'touch' || (tool === 'hand' && e.button === 0) || e.button === 1)
    )
      return;
    e.preventDefault();
    flush();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.down(e.pointerId, e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      touches.current.add(e.pointerId);
      if (touches.current.size === 1) {
        singleTouch.current = true;
        velocity.current.reset();
        velocity.current.add(e.clientX, e.clientY, e.timeStamp);
      } else {
        singleTouch.current = false;
        velocity.current.reset();
      }
    }
  };
  const move = (e: ReactPointerEvent) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.move(e.pointerId, e.clientX, e.clientY);
      if (e.pointerType === 'touch' && singleTouch.current)
        velocity.current.add(e.clientX, e.clientY, e.timeStamp);
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    }
  };
  const end = (e: ReactPointerEvent, cancel = false) => {
    if (!pointers.current.has(e.pointerId)) return;
    if (!cancel) {
      pointers.current.move(e.pointerId, e.clientX, e.clientY);
      flush();
    }
    const speed =
      e.pointerType === 'touch' && singleTouch.current && !cancel
        ? velocity.current.release(e.timeStamp)
        : { x: 0, y: 0 };
    pointers.current.up(e.pointerId);
    touches.current.delete(e.pointerId);
    if (!touches.current.size) {
      singleTouch.current = false;
      velocity.current.reset();
    }
    if (cancel) stopInertia();
    else startInertia(speed);
  };
  useEffect(() => {
    stopInertia();
  }, [tool, mode, zoom]);
  const start = mode === 'dual' ? index : range.start,
    endIndex = mode === 'dual' ? index + 2 : range.end;
  return (
    <div
      className={`reading-view reading-${mode} tool-${tool}`}
      ref={root}
      onKeyDown={stopInertia}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(e) => end(e)}
      onPointerCancel={(e) => end(e, true)}
      onLostPointerCapture={(e) => end(e, true)}
    >
      <div
        className={`reading-pages ${mode === 'continuous' ? 'virtual-reading-layout' : ''}`}
        ref={content}
        style={
          mode === 'continuous'
            ? {
                width: widest * zoom + 16,
                height: `calc(${8 + layout.total + 8}px + var(--page-controls-inset,0px))`,
              }
            : undefined
        }
      >
        {pages.slice(start, endIndex).map((page, i) => (
          <ReadingPage
            key={page.id}
            page={page}
            pdf={pdf}
            number={start + i + 1}
            selectable={tool === 'select'}

            width={page.width * zoom}
            top={mode === 'continuous' ? 8 + layout.offsets[start + i] : undefined}
            onEdit={onEdit}
            viewport={root}
            hand={tool === 'hand'}
          />
        ))}
      </div>
    </div>
  );
}
