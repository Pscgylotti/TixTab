import { MIN_ZOOM, MAX_ZOOM } from './pageFit';
import { performanceDelay, trackPerformance } from './performanceLedger';
import { useAppearance, renderPolicy, pageRenderScale } from './appearance';
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
import type { PDFDocumentProxy } from './pdfTypes';
import { PenLine } from 'lucide-react';
import { PanZoomPointers } from './gestures';
import { useDeferredZoom } from './useDeferredZoom';
import PageEditor from './PageEditor';
import type { PenDiagnostic } from './PdfSurface';
import PdfDetailLayer from './PdfDetailLayer';
import NativePdfPreview from './NativePdfPreview';
import { useLiveNativeEdit } from './nativePdfDrafts';
import { paperAppearance } from './paperAppearance';
import { requestPdfBitmap, renderingCancelled } from './pdfRenderCache';
import { usePdfBitmapDisplay } from './usePdfBitmapDisplay';
import type { Page, Tool } from './model';
import { makeLayout, visibleRange, itemAt } from './virtualLayout';
import { useScrollViewport } from './useScrollViewport';
import { zoomReadingPoint } from './readingZoom';
import { ScrollVelocity, inertiaStep } from './scrollInertia';
import type { WorkspacePosition } from './workspaceStore';
const ReadingPage = memo(function ReadingPage({
  page,
  pdf,
  number,
  tool,
  color,
  size,
  onChange,
  onDiagnostic,
  onContext,
  onEditObject,
  focusObjectId,
  active,
  onActivate,
  onEdit,
  width,

  top,
  viewport,
}: {
  page: Page;
  pdf: PDFDocumentProxy | null;
  number: number;
  tool: Tool;
  color: string;
  size: number;
  onChange: (page: Page) => void;
  onDiagnostic: (d: PenDiagnostic) => void;
  onContext: (x: number, y: number) => void;
  onEditObject: (page: Page, id: string) => void;
  focusObjectId: string | string[] | null;
  active: boolean;
  onActivate: (id: string) => void;
  onEdit: (i: number) => void;
  width: number;

  top?: number;
  viewport: RefObject<HTMLElement | null>;
}) {
  useLocale();
  const nativeLive = useLiveNativeEdit(page.id);
  const { pdfNight } = useAppearance(),
    policy = renderPolicy();
  const root = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState(false),
    [status, setStatus] = useState(tr('等待预览'));
  const { host, display, recovery } = usePdfBitmapDisplay('reading-pdf');
  useLayoutEffect(() => {
    display.current?.retainPreview();
  }, [width]);
  const scale = width / page.width;
  const [settledWidth, setSettledWidth] = useState(width);
  const renderScale = pageRenderScale(
    settledWidth / page.width,
    window.devicePixelRatio,
    page.width,
    page.height,
    true,
    policy,
  );
  useEffect(() => {
    return performanceDelay('view-settle', () => setSettledWidth(width), policy.settleMs);
  }, [width, policy.settleMs]);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: policy.minimal ? '0px' : '300px',
    });
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, [policy.minimal]);
  useEffect(() => {
    let dead = false,
      cancel: (() => void) | undefined;
    if (!pdf || page.sourceIndex === null) {
      display.current!.clear();
      return;
    }
    if (!visible) {
      display.current!.retainPreview();
      display.current!.showPreview();
      return;
    }
    setStatus(tr('加载预览…'));
    const lease = requestPdfBitmap(pdf, page.sourceIndex, renderScale, 1, pdfNight);
    cancel = lease.cancel;
    void trackPerformance('pdf-display', () =>
      lease.promise.then((bitmap) => {
        if (!dead) {
          display.current!.show(bitmap, pdfNight);
          setStatus(tr('就绪'));
        }
      }),
    ).catch((e) => {
      if (!dead && !renderingCancelled(e)) setStatus(tr('预览失败'));
    });
    return () => {
      dead = true;
      cancel?.();
    };
  }, [
    pdf,
    recovery,
    page.id,
    visible,
    renderScale,

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
        data-pdf-source={page.sourceIndex ?? ''}
        data-blank-paper={page.sourceIndex === null ? true : undefined}
        style={{
          width,
          height: page.height * scale,
          ...(page.sourceIndex === null ? paperAppearance(page, pdfNight) : {}),
        }}
      >
        <div
          className={`reading-content ${tool === 'select' ? 'selectable' : ''}`}
          data-pdf-night={pdfNight}
          style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
        >
          <div ref={host} style={{ display: 'contents' }} />
          {visible && (page.pdfEdits?.length || nativeLive) && (
            <NativePdfPreview page={page} zoom={settledWidth / page.width} />
          )}
          <PdfDetailLayer
            pdf={visible && !page.pdfEdits?.length && !nativeLive ? pdf : null}
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
              <PageEditor
                page={page}
                pdf={pdf}
                tool={tool}
                color={color}
                size={size}
                zoom={scale}
                onChange={onChange}
                onDiagnostic={onDiagnostic}
                onContext={onContext}
                onEditObject={(id) => onEditObject(page, id)}
                focusObjectId={focusObjectId}
                viewport={viewport}
                active={active}
                onActivate={() => onActivate(page.id)}
                reading
                viewKey={`${top}:${scale}`}
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
});
export default function ReadingView({
  freeView = false,
  editableActive = true,
  restoredPosition,
  pages,
  pdf,
  mode,
  index,
  tool,
  color,
  size,
  onChange,
  onDiagnostic,
  onContext,
  onEditObject,
  focusObjectId,

  zoom: committedZoom,
  setZoom: commitZoom,
  resetView,
  onEdit,
  onPageChange,
}: {
  freeView?: boolean;
  editableActive?: boolean;
  restoredPosition?: WorkspacePosition;
  pages: Page[];
  pdf: PDFDocumentProxy | null;
  mode: 'continuous' | 'dual';
  index: number;
  tool: Tool;
  color: string;
  size: number;
  onChange: (page: Page) => void;
  onDiagnostic: (d: PenDiagnostic) => void;
  onContext: (x: number, y: number) => void;
  onEditObject: (page: Page, id: string) => void;
  focusObjectId: string | string[] | null;

  zoom: number;
  setZoom: (zoom: number) => void;
  resetView: number;
  onEdit: (i: number) => void;
  onPageChange: (i: number) => void;
}) {
  useLocale();
  const seamless = freeView && mode === 'continuous',
    pageInset = seamless ? 0 : 8;
  const [freeOffset, setFreeOffset] = useState({ x: 0, y: 0 });
  const freeState = useRef({ enabled: freeView, offset: freeOffset });
  freeState.current = { enabled: freeView, offset: freeOffset };
  useLayoutEffect(() => setFreeOffset({ x: 0, y: 0 }), [resetView, freeView]);
  const [zoom, setZoom] = useDeferredZoom(committedZoom, commitZoom, resetView);
  const root = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    pointers = useRef(new PanZoomPointers()),
    frame = useRef(0);
  const [activePageId, setActivePageId] = useState(pages[index]?.id);
  const penTime = useRef(-Infinity);
  useEffect(() => {
    const page = pages.find((p) =>
      p.images.some((i) =>
        Array.isArray(focusObjectId) ? focusObjectId.includes(i.id) : i.id === focusObjectId,
      ),
    );
    if (page) setActivePageId(page.id);
  }, [focusObjectId]);

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
    if (freeView || mode !== 'continuous' || Math.hypot(speed.x, speed.y) < 0.12) return;
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
        pages.map((page) => page.height * zoom + (seamless ? 0 : 25)),
        pageInset,
      ),
    [pages, zoom, seamless],
  );
  const widest = useMemo(
    () => pages.reduce((width, page) => Math.max(width, page.width), 0),
    [pages],
  );
  const observedIndex = useRef<number | null>(null),
    lastReset = useRef(resetView),
    lastMode = useRef<typeof mode | null>(null);
  const restored = useRef<WorkspacePosition | undefined>(undefined);
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
    seamless: boolean;
    reset: number;
  } | null>(null);
  const prev = previous.current;
  const zoomAnchor =
    prev &&
    prev.zoom !== zoom &&
    prev.mode === mode &&
    prev.pages === pages &&
    prev.seamless === seamless &&
    prev.reset === resetView
      ? (anchor.current ?? {
          x: prev.width / 2,
          y: prev.height / 2,
          contentX: prev.left + prev.width / 2 - (freeView ? freeOffset.x : 0),
          contentY: prev.top + prev.height / 2 - (freeView ? freeOffset.y : 0),
        })
      : null;
  const zoomPosition =
    zoomAnchor && prev
      ? zoomReadingPoint(
          pages,
          mode,
          prev.index,
          prev.width,
          prev.zoom,
          zoom,
          {
            x: zoomAnchor.contentX,
            y: zoomAnchor.contentY,
          },
          seamless,
        )
      : null;
  // Virtualize using the *new* anchored scroll position in the same render.
  // Combining a new layout with the old scrollTop can replace page 179 with
  // page 160 for one commit, destroying every visible raster before zooming.
  const rangeTop =
    zoomPosition && zoomAnchor
      ? Math.max(0, (content.current?.offsetTop ?? 0) + zoomPosition.y - zoomAnchor.y)
      : viewport.top - (freeView ? freeOffset.y : 0);
  const range = visibleRange(
    layout,
    rangeTop - pageInset,
    viewport.height,
    renderPolicy().minimal ? 0 : Math.max(400, viewport.height),
  );
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
        contentX:
          el.scrollLeft +
          x -
          body.offsetLeft -
          (freeState.current.enabled ? freeState.current.offset.x : 0),
        contentY:
          el.scrollTop +
          y -
          body.offsetTop -
          (freeState.current.enabled ? freeState.current.offset.y : 0),
      };
    zoomRef.current = next;
    setZoom(next);
  };
  useLayoutEffect(() => {
    const el = root.current!,
      body = content.current!;
    if (zoomPosition && zoomAnchor) {
      if (freeState.current.enabled) {
        setFreeOffset({
          x: zoomAnchor.x - body.offsetLeft - zoomPosition.x + el.scrollLeft,
          y: zoomAnchor.y - body.offsetTop - zoomPosition.y + el.scrollTop,
        });
      } else {
        el.scrollLeft = body.offsetLeft + zoomPosition.x - zoomAnchor.x;
        el.scrollTop = body.offsetTop + zoomPosition.y - zoomAnchor.y;
        measure();
      }
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
      seamless,
      reset: resetView,
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
    } else if (freeState.current.enabled) {
      setFreeOffset((o) => ({ x: o.x + delta.dx, y: o.y + delta.dy }));
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
      } else if (freeState.current.enabled) {
        e.preventDefault();
        setFreeOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
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
    const restore =
      restoredPosition &&
      restored.current !== restoredPosition &&
      restoredPosition.mode === mode &&
      restoredPosition.pageId === pages[index]?.id;
    if (
      mode === 'continuous' &&
      lastMode.current === mode &&
      observedIndex.current === index &&
      lastReset.current === resetView &&
      !restore
    )
      return;
    lastMode.current = mode;
    lastReset.current = resetView;
    observedIndex.current = index;
    stopInertia();
    velocity.current.reset();
    touches.current.clear();
    singleTouch.current = false;
    pointers.current.reset();
    if (restore) {
      restored.current = restoredPosition;
      el.scrollLeft = restoredPosition.x * zoom;
      el.scrollTop = restoredPosition.y * zoom;
      if (freeView)
        setFreeOffset({ x: restoredPosition.freeX ?? 0, y: restoredPosition.freeY ?? 0 });
    } else {
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
      if (mode === 'continuous') el.scrollTop = pageInset + (layout.offsets[index] ?? 0);
      else el.scrollTop = 0;
    }
    measure();
  }, [index, mode, resetView, pages[index]?.id, restoredPosition]);
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
      Math.max(
        0,
        viewport.top -
          pageInset -
          (freeView ? freeOffset.y : 0) +
          Math.max(1, viewport.height - inset) * 0.4,
      ),
    );
    if (next !== observedIndex.current) {
      observedIndex.current = next;
      onPageChange(next);
    }
  }, [
    viewport.top,
    viewport.height,
    layout,
    mode,
    onPageChange,
    freeView,
    freeOffset.y,
    pageInset,
  ]);
  const down = (e: ReactPointerEvent) => {
    stopInertia();
    if (
      (e.target as HTMLElement).closest('button,a') ||
      (e.pointerType === 'touch' && performance.now() - penTime.current < 650) ||
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
      className={`reading-view reading-${mode} tool-${tool}${seamless ? ' reading-seamless' : ''}`}
      data-view-zoom={zoom}
      data-free-x={freeOffset.x}
      data-free-y={freeOffset.y}
      ref={root}
      onKeyDown={stopInertia}
      onPointerDownCapture={(e) => {
        stopInertia();
        if (e.pointerType === 'pen') penTime.current = performance.now();
      }}
      onPointerMoveCapture={(e) => {
        if (e.pointerType === 'pen') penTime.current = performance.now();
      }}
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
                transform: freeView ? `translate(${freeOffset.x}px,${freeOffset.y}px)` : undefined,
                width: widest * zoom + 16,
                height: `calc(${pageInset + layout.total + pageInset}px + var(--page-controls-inset,0px))`,
              }
            : freeView
              ? { transform: `translate(${freeOffset.x}px,${freeOffset.y}px)` }
              : undefined
        }
      >
        {pages.slice(start, endIndex).map((page, i) => (
          <ReadingPage
            key={page.id}
            page={page}
            pdf={pdf}
            number={start + i + 1}
            tool={tool}
            color={color}
            size={size}
            onChange={onChange}
            onDiagnostic={onDiagnostic}
            onContext={onContext}
            onEditObject={onEditObject}
            focusObjectId={focusObjectId}
            active={editableActive && activePageId === page.id}
            onActivate={setActivePageId}

            width={page.width * zoom}
            top={mode === 'continuous' ? pageInset + layout.offsets[start + i] : undefined}
            onEdit={onEdit}
            viewport={root}
          />
        ))}
      </div>
    </div>
  );
}
