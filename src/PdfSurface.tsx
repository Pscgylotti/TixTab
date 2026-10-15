import { MIN_ZOOM, MAX_ZOOM } from './pageFit';
import { performanceDelay, trackPerformance } from './performanceLedger';
import { useAppearance, renderPolicy, pageRenderScale } from './appearance';
import { t as tr, useLocale } from './i18n';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { priorPdfBitmap, requestPdfBitmap, renderingCancelled } from './pdfRenderCache';
import { usePdfBitmapDisplay } from './usePdfBitmapDisplay';
import type { Page, Tool } from './model';
import PageEditor, { clipsForeground } from './PageEditor';
import { committedInkRatio } from './committedInk';
import PdfDetailLayer from './PdfDetailLayer';
import { PanZoomPointers } from './gestures';
import { useDeferredZoom } from './useDeferredZoom';
import { objectBox } from './objectSelection';
import { useNavigation } from './DocumentNavigator';
import NativePdfPreview from './NativePdfPreview';
import { useLiveNativeEdit } from './nativePdfDrafts';
import { paperAppearance } from './paperAppearance';
import type { WorkspacePosition } from './workspaceStore';
export interface PenDiagnostic {
  type: string;
  pressure: number;
  eraser: boolean;
  samples: number;
}
interface Props {
  restoredPosition?: WorkspacePosition;
  page: Page;
  pdf: PDFDocumentProxy | null;
  tool: Tool;
  color: string;
  size: number;

  zoom: number;
  resetView: number;
  fitWidth?: boolean;
  setZoom: (zoom: number) => void;
  onChange: (page: Page) => void;
  onDiagnostic: (d: PenDiagnostic) => void;
  onRender: (s: string) => void;
  onContext: (x: number, y: number) => void;
  onEditObject: (id: string) => void;
  focusObjectId: string | string[] | null;
}
export default function PdfSurface({
  restoredPosition,
  page,
  pdf,
  tool,
  color,
  size,

  zoom: committedZoom,
  resetView,
  fitWidth = false,
  setZoom: commitZoom,
  onChange,
  onDiagnostic,
  onRender,
  onContext,
  onEditObject,
  focusObjectId,
}: Props) {
  useLocale();
  const nativeLive = useLiveNativeEdit(page.id);
  const navigation = useNavigation();
  const { pdfNight, pdfRenderBackend } = useAppearance(),
    policy = renderPolicy();
  const [zoom, setZoom] = useDeferredZoom(committedZoom, commitZoom, resetView);
  const stage = useRef<HTMLDivElement>(null);
  const { host, display, recovery } = usePdfBitmapDisplay('pdf-layer');
  useLayoutEffect(() => {
    display.current?.retainPreview();
  }, [zoom]);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const restored = useRef<WorkspacePosition | undefined>(undefined);
  useEffect(() => {
    const image = objectBox(
      page.images,
      Array.isArray(focusObjectId) ? focusObjectId : focusObjectId ? [focusObjectId] : [],
    );
    if (image)
      setOffset({
        x: (page.width / 2 - image.x - image.width / 2) * zoom,
        y: (page.height / 2 - image.y - image.height / 2) * zoom,
      });
  }, [focusObjectId]);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const penTime = useRef(-Infinity);
  const pointers = useRef(new PanZoomPointers()),
    transformFrame = useRef(0);
  const shownPage = useRef('');
  const [settledZoom, setSettledZoom] = useState(zoom);
  const zoomTo = (value: number, clientX?: number, clientY?: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    const rect = stage.current!.getBoundingClientRect();
    const x = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
    const y = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
    const ratio = next / zoomRef.current;
    const prev = offsetRef.current;
    const newOffset = { x: x - (x - prev.x) * ratio, y: y - (y - prev.y) * ratio };
    offsetRef.current = newOffset;
    setOffset(newOffset);
    zoomRef.current = next;
    setZoom(next);
  };
  const flushTransform = () => {
    cancelAnimationFrame(transformFrame.current);
    transformFrame.current = 0;
    const delta = pointers.current.take();
    if (!delta) return;
    if (delta.scale !== 1) zoomTo(zoomRef.current * delta.scale, delta.x, delta.y);
    const next = { x: offsetRef.current.x + delta.dx, y: offsetRef.current.y + delta.dy };
    offsetRef.current = next;
    setOffset(next);
  };
  useEffect(() => {
    return performanceDelay('view-settle', () => setSettledZoom(zoom), policy.settleMs);
  }, [zoom, policy.settleMs]);
  useLayoutEffect(() => {
    if (
      restoredPosition &&
      restored.current !== restoredPosition &&
      restoredPosition.mode === 'single' &&
      restoredPosition.pageId === page.id
    ) {
      restored.current = restoredPosition;
      setOffset({ x: restoredPosition.x * zoom, y: restoredPosition.y * zoom });
      return;
    }
    setOffset({
      x: 0,
      y: fitWidth
        ? Math.max(0, (page.height * zoom - (stage.current?.clientHeight ?? 0)) / 2 + 8)
        : 0,
    });
  }, [page.id, resetView, restoredPosition]);
  useEffect(() => {
    const target = navigation?.target;
    if (target?.pageId === page.id && target.rect) {
      const r = target.rect;
      setOffset({
        x: (page.width / 2 - r.x - r.width / 2) * zoom,
        y: (page.height / 2 - r.y - r.height / 2) * zoom,
      });
    }
  }, [navigation?.target, page.id]);
  useEffect(() => {
    const el = stage.current!;
    // A precision touchpad can report several wheel steps per frame; move once.
    let dx = 0,
      dy = 0,
      frame = 0;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey)
        zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
      else {
        dx += e.deltaX;
        dy += e.deltaY;
        frame ||= requestAnimationFrame(() => {
          const x = dx,
            y = dy;
          dx = dy = frame = 0;
          setOffset((o) => ({ x: o.x - x, y: o.y - y }));
        });
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('wheel', wheel);
    };
  }, []);
  useEffect(() => {
    let dead = false,
      cancel: (() => void) | undefined;
    if (shownPage.current !== `${page.id}:${pdfNight}`) {
      shownPage.current = `${page.id}:${pdfNight}`;
      display.current!.clear();
    }
    const show = (cached: HTMLCanvasElement) => {
      if (dead) return;
      display.current!.show(cached, pdfNight);
    };
    const run = async () => {
      if (!pdf || page.sourceIndex === null) {
        onRender(tr('\u7A7A\u767D\u7EB8\u5F20'));
        return;
      }
      const cap = Math.sqrt(policy.basePixels / (page.width * page.height));
      const target = pageRenderScale(
        settledZoom,
        window.devicePixelRatio,
        page.width,
        page.height,
        false,

        policy,
      );
      const render = async (scale: number) => {
        if (dead) return;
        const lease = requestPdfBitmap(pdf, page.sourceIndex!, scale, 0, pdfNight);
        cancel = lease.cancel;
        show(await lease.promise);
      };
      const prior = priorPdfBitmap(pdf, page.sourceIndex, pdfNight);
      if (prior) show(prior);
      else if (!policy.minimal) {
        onRender(tr('\u751F\u6210\u9884\u89C8\u2026'));
        await render(Math.min(0.7, cap));
      }
      if (dead) return;
      onRender(tr('补充高清…'));
      await render(target);
      if (!dead) onRender(tr('高清 · 就绪'));
    };
    void trackPerformance('pdf-display', run).catch((e) => {
      if (!dead && !renderingCancelled(e))
        onRender(tr('\u6E32\u67D3\u5931\u8D25\uFF1A{0}', e.message));
    });
    return () => {
      dead = true;
      cancel?.();
    };
  }, [
    pdf,
    recovery,
    page.id,
    page.sourceIndex,
    settledZoom,

    pdfNight,
    pdfRenderBackend,
    policy.basePixels,
    policy.dpr,
    policy.baseScale,
    policy.sampling,
    policy.minimal,
  ]);
  useEffect(
    () => () => {
      cancelAnimationFrame(transformFrame.current);
      transformFrame.current = 0;
    },
    [],
  );
  const down = (e: ReactPointerEvent) => {
    if (!(e.pointerType === 'touch' || (tool === 'hand' && e.button === 0) || e.button === 1))
      return;
    if (
      (e.target as HTMLElement).closest('button') ||
      (e.pointerType === 'touch' && performance.now() - penTime.current < 650)
    )
      return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    flushTransform();
    pointers.current.down(e.pointerId, e.clientX, e.clientY);
  };
  const move = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.move(e.pointerId, e.clientX, e.clientY);
    if (!transformFrame.current) transformFrame.current = requestAnimationFrame(flushTransform);
  };
  const end = (e: ReactPointerEvent, cancel = false) => {
    if (!pointers.current.has(e.pointerId)) return;
    if (!cancel) {
      pointers.current.move(e.pointerId, e.clientX, e.clientY);
      flushTransform();
    }
    pointers.current.up(e.pointerId);
  };
  return (
    <div
      className={`surface tool-${tool}`}
      data-view-zoom={zoom}
      data-pan-x={offset.x}
      data-pan-y={offset.y}
      ref={stage}
      onPointerDownCapture={(e) => {
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
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
    >
      <div
        className="paper-position"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        <div
          className={`paper paper-${page.sourceIndex === null ? page.paper : 'plain'}`}
          data-pdf-night={pdfNight}
          data-pdf-source={page.sourceIndex ?? ''}
          data-page-id={page.id}
          data-blank-paper={page.sourceIndex === null ? true : undefined}
          style={{
            ...(page.sourceIndex === null ? paperAppearance(page, pdfNight) : {}),
            width: page.width,
            height: page.height,
            transform: `translate(-50%, -50%) scale(${zoom})`,
          }}
        >
          <div ref={host} style={{ display: 'contents' }} />
          {(page.pdfEdits?.length || nativeLive) && (
            <NativePdfPreview page={page} zoom={settledZoom} />
          )}
          <PdfDetailLayer
            pdf={page.pdfEdits?.length || nativeLive ? null : pdf}
            sourceIndex={page.sourceIndex}
            width={page.width}
            height={page.height}
            zoom={zoom}
            baseScale={pageRenderScale(
              zoom,
              window.devicePixelRatio,
              page.width,
              page.height,
              false,

              policy,
            )}

            viewport={stage}
            viewKey={`${offset.x}:${offset.y}`}
            priority={0}
          />
          <PageEditor
            page={page}
            pdf={pdf}
            tool={tool}
            color={color}
            size={size}
            zoom={zoom}
            onChange={onChange}
            onDiagnostic={onDiagnostic}
            onContext={onContext}
            onEditObject={onEditObject}
            focusObjectId={focusObjectId}
            viewport={stage}
            // A view key that changes with every pan frame would re-render the
            // whole editor; only pages that clip their foreground need it.
            viewKey={
              clipsForeground(page, zoom * window.devicePixelRatio > committedInkRatio(page))
                ? `${offset.x}:${offset.y}:${zoom}`
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
