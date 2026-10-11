import { MIN_ZOOM, MAX_ZOOM } from './pageFit';
import { useAppearance, renderPolicy, pageRenderScale } from './appearance';
import PdfOriginalImages from './PdfOriginalImages';
import { t as tr, useLocale } from './i18n';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { priorPdfBitmap, requestPdfBitmap, renderingCancelled } from './pdfRenderCache';
import { drawStroke, drawStrokes } from './ink';
import {
  hitStroke,
  hitImage,
  isEraser,
  uid,
  type Page,
  type Point,
  type Stroke,
  type Tool,
} from './model';
import PdfTextLayer from './PdfTextLayer';
import PdfDetailLayer from './PdfDetailLayer';
import { PanZoomPointers } from './gestures';
import ObjectLayer from './ObjectLayer';
import { Pencil, Trash2, X } from 'lucide-react';
export interface PenDiagnostic {
  type: string;
  pressure: number;
  eraser: boolean;
  samples: number;
}
interface Props {
  page: Page;
  pdf: PDFDocumentProxy | null;
  tool: Tool;
  color: string;
  size: number;

  zoom: number;
  resetView: number;
  setZoom: (zoom: number) => void;
  onChange: (page: Page) => void;
  onDiagnostic: (d: PenDiagnostic) => void;
  onRender: (s: string) => void;
  onContext: (x: number, y: number) => void;
  onEditObject: (id: string) => void;
  focusObjectId: string | null;
}
export default function PdfSurface({
  page,
  pdf,
  tool,
  color,
  size,

  zoom,
  resetView,
  setZoom,
  onChange,
  onDiagnostic,
  onRender,
  onContext,
  onEditObject,
  focusObjectId,
}: Props) {
  useLocale();
  const { pdfNight } = useAppearance(),
    policy = renderPolicy();
  const stage = useRef<HTMLDivElement>(null),
    paper = useRef<HTMLDivElement>(null),
    background = useRef<HTMLCanvasElement>(null),
    ink = useRef<HTMLCanvasElement>(null),
    live = useRef<HTMLCanvasElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    setSelected((ids) => {
      const valid = ids.filter((id) => page.images.some((image) => image.id === id));
      return valid.length === ids.length ? ids : valid;
    });
  }, [page.images]);
  const selectedImage =
    selected.length === 1 ? page.images.find((i) => i.id === selected[0]) : undefined;
  useEffect(() => {
    setSelected([]);
  }, [page.id, tool]);
  const deleteSelected = () => {
    if (selected.length) {
      onChange({ ...page, images: page.images.filter((i) => !selected.includes(i.id)) });
      setSelected([]);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        tool !== 'object' ||
        !selected.length ||
        (e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]') ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      if (e.key === 'Delete') {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === 'Escape') setSelected([]);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [tool, selected, page]);
  useEffect(() => {
    const i = page.images.find((i) => i.id === focusObjectId);
    if (i) {
      setSelected([i.id]);
      setOffset({
        x: (page.width / 2 - i.x - i.width / 2) * zoom,
        y: (page.height / 2 - i.y - i.height / 2) * zoom,
      });
    }
  }, [focusObjectId]);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pageRef = useRef(page);
  pageRef.current = page;
  const stroke = useRef<Stroke | null>(null),
    erased = useRef<{
      strokes: Set<string>;
      images: Set<string>;
    } | null>(null),
    eraseLast = useRef<Point | null>(null),
    drawingPointer = useRef<number | null>(null);
  const [pendingImages, setPendingImages] = useState<string[]>([]),
    [pendingCount, setPendingCount] = useState(0);
  const pointers = useRef(new PanZoomPointers()),
    transformFrame = useRef(0),
    penTime = useRef(-Infinity),
    frame = useRef(0),
    diagTime = useRef(0);
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
    const t = setTimeout(() => setSettledZoom(zoom), policy.settleMs);
    return () => clearTimeout(t);
  }, [zoom, policy.settleMs]);
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
  }, [page.id, resetView]);
  useEffect(() => {
    const el = stage.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey)
        zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
      else setOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    let dead = false,
      cancel: (() => void) | undefined;
    const canvas = background.current!,
      context = canvas.getContext('2d')!;
    if (shownPage.current !== `${page.id}:${pdfNight}`) {
      shownPage.current = `${page.id}:${pdfNight}`;
      canvas.width = 1;
      canvas.height = 1;
    }
    const show = (cached: HTMLCanvasElement) => {
      if (dead) return;
      canvas.width = cached.width;
      canvas.height = cached.height;
      canvas.getContext('2d')!.drawImage(cached, 0, 0);
      canvas.dataset.renderedNight = String(pdfNight);
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
      else {
        onRender(tr('\u751F\u6210\u9884\u89C8\u2026'));
        await render(Math.min(0.7, cap));
      }
      if (dead) return;
      onRender(tr('补充高清…'));
      await render(target);
      if (!dead) onRender(tr('高清 · 就绪'));
    };
    void run().catch((e) => {
      if (!dead && !renderingCancelled(e))
        onRender(tr('\u6E32\u67D3\u5931\u8D25\uFF1A{0}', e.message));
    });
    return () => {
      dead = true;
      cancel?.();
    };
  }, [
    pdf,
    page.id,
    page.sourceIndex,
    settledZoom,

    pdfNight,
    policy.basePixels,
    policy.dpr,
    policy.baseScale,
    policy.sampling,
  ]);
  const redraw = (strokes = pageRef.current.strokes) => {
    const c = ink.current!,
      ctx = c.getContext('2d')!;
    const ratio = c.width / pageRef.current.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawStrokes(ctx, strokes);
  };
  useEffect(() => {
    const ratio = Math.min(2, Math.sqrt(4000000 / (page.width * page.height)));
    for (const canvas of [ink.current!, live.current!]) {
      canvas.width = Math.ceil(page.width * ratio);
      canvas.height = Math.ceil(page.height * ratio);
    }
    redraw(page.strokes);
    const c = live.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  }, [page]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(transformFrame.current);
    },
    [],
  );
  const point = (e: PointerEvent): Point => {
    const r = paper.current!.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / r.width) * page.width,
      ((e.clientY - r.top) / r.height) * page.height,
      e.pointerType === 'pen' ? Math.max(0.01, e.pressure) : 0.5,
    ];
  };
  const queueInk = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const canvas = live.current!,
        ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const r = canvas.width / pageRef.current.width;
      ctx.setTransform(r, 0, 0, r, 0, 0);
      const pending = erased.current;
      if (pending) {
        for (const s of pageRef.current.strokes)
          if (pending.strokes.has(s.id))
            drawStroke(ctx, { ...s, tool: 'ballpoint', color: '#e05b62', size: s.size + 3 });
        setPendingImages([...pending.images]);
        setPendingCount(pending.images.size + pending.strokes.size);
      } else {
        setPendingImages([]);
        setPendingCount(0);
      }
      if (stroke.current) drawStroke(ctx, stroke.current);
    });
  };
  const sample = (e: PointerEvent) => {
    const p = point(e);
    if (erased.current) {
      const from = eraseLast.current ?? p,
        radius = Math.max(8, size * 2);
      for (const s of pageRef.current.strokes)
        if (!erased.current.strokes.has(s.id) && hitStroke(s, from, p, radius))
          erased.current.strokes.add(s.id);
      for (const image of pageRef.current.images)
        if (!erased.current.images.has(image.id) && hitImage(image, from, p, radius))
          erased.current.images.add(image.id);
      eraseLast.current = p;
    } else if (stroke.current) stroke.current.points.push(p);
    if (performance.now() - diagTime.current > 90) {
      onDiagnostic({
        type: e.pointerType,
        pressure: e.pressure,
        eraser: !!erased.current,
        samples: stroke.current?.points.length ?? 0,
      });
      diagTime.current = performance.now();
    }
  };
  const down = (e: ReactPointerEvent) => {
    if (e.button === 2 || (e.pointerType === 'pen' && e.buttons & 2)) {
      e.preventDefault();
      onContext(e.clientX, e.clientY);
      return;
    }
    if (tool === 'select' && !isEraser(e) && e.pointerType !== 'touch') return;
    if (tool === 'object' && !isEraser(e) && e.button !== 1 && e.pointerType !== 'touch') {
      setSelected([]);
      return;
    }
    if (e.pointerType === 'pen') penTime.current = performance.now();
    if (
      e.pointerType === 'touch' &&
      (drawingPointer.current !== null || performance.now() - penTime.current < 650)
    )
      return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch' || (tool === 'hand' && !isEraser(e)) || e.button === 1) {
      flushTransform();
      pointers.current.down(e.pointerId, e.clientX, e.clientY);
      return;
    }
    if (drawingPointer.current !== null) return;
    pointers.current.reset();
    drawingPointer.current = e.pointerId;
    if (tool === 'eraser' || isEraser(e)) {
      erased.current = { strokes: new Set(), images: new Set() };
      eraseLast.current = point(e.nativeEvent);
    } else stroke.current = { id: uid(), tool, color, size, points: [] };
    sample(e.nativeEvent);
    queueInk();
  };
  const move = (e: ReactPointerEvent) => {
    if (e.pointerType === 'pen') penTime.current = performance.now();
    if (pointers.current.has(e.pointerId)) {
      pointers.current.move(e.pointerId, e.clientX, e.clientY);
      if (!transformFrame.current) transformFrame.current = requestAnimationFrame(flushTransform);
      return;
    }
    if (drawingPointer.current !== e.pointerId) return;
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const event of samples.length ? samples : [e.nativeEvent]) sample(event);
    queueInk();
  };
  const end = (e: ReactPointerEvent, cancel = false) => {
    if (!cancel && pointers.current.has(e.pointerId)) {
      pointers.current.move(e.pointerId, e.clientX, e.clientY);
      flushTransform();
    }
    pointers.current.up(e.pointerId);
    if (drawingPointer.current !== e.pointerId) return;
    if (!cancel && erased.current) sample(e.nativeEvent);
    if (!cancel) {
      // Pointer-up pressure is zero; keep the last contact pressure to avoid an artificial taper.
      if (stroke.current)
        onChange({ ...pageRef.current, strokes: [...pageRef.current.strokes, stroke.current] });
      else if (erased.current && (erased.current.strokes.size || erased.current.images.size)) {
        const pending = erased.current;
        onChange({
          ...pageRef.current,
          strokes: pageRef.current.strokes.filter((s) => !pending.strokes.has(s.id)),
          images: pageRef.current.images.filter((i) => !pending.images.has(i.id)),
        });
      }
    }
    stroke.current = null;
    erased.current = null;
    eraseLast.current = null;
    drawingPointer.current = null;
    setPendingImages([]);
    setPendingCount(0);
    queueInk();
  };
  return (
    <div
      className={`surface tool-${tool}`}
      ref={stage}
      data-pending-erase={pendingCount}
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
          ref={paper}
          style={{
            width: page.width,
            height: page.height,
            transform: `translate(-50%, -50%) scale(${zoom})`,
          }}
        >
          <canvas className="pdf-layer" ref={background} />
          <PdfDetailLayer
            pdf={pdf}
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
          <PdfOriginalImages pdf={pdf} sourceIndex={page.sourceIndex} enabled={tool === 'hand'} />
          <ObjectLayer
            page={page}
            active={tool === 'object'}
            zoom={zoom}
            selected={selected}
            onSelect={setSelected}
            onChange={onChange}
          />
          <canvas className="ink-layer" ref={ink} />
          <canvas className="live-layer" ref={live} />
          {pendingImages.map((id) => {
            const image = page.images.find((i) => i.id === id);
            return (
              image && (
                <div
                  key={id}
                  className="pending-erase-object"
                  style={{
                    left: image.x,
                    top: image.y,
                    width: image.width,
                    height: image.height,
                    borderWidth: 2 / zoom,
                  }}
                />
              )
            );
          })}
          {tool === 'select' && <PdfTextLayer pdf={pdf} sourceIndex={page.sourceIndex} />}
        </div>
      </div>
      {tool === 'object' && selected.length > 0 && (
        <div className="object-inspector" onPointerDown={(e) => e.stopPropagation()}>
          <span>
            {selectedImage
              ? selectedImage.kind === 'sketch'
                ? tr('草图')
                : tr('公式')
              : tr('已选择 {0} 个对象', selected.length)}{' '}
            {tr('· 拖动移动，边角缩放')}
          </span>
          {selectedImage && (
            <button
              aria-label={selectedImage.kind === 'sketch' ? tr('编辑选中草图') : tr('编辑选中公式')}
              onClick={() => onEditObject(selectedImage.id)}
            >
              <Pencil size={15} />
              {tr('编辑')}
            </button>
          )}
          <button aria-label={tr('删除选中对象')} onClick={deleteSelected}>
            <Trash2 size={15} />
          </button>
          <button aria-label={tr('取消对象选择')} onClick={() => setSelected([])}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
