import {
  memo,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Pencil, Trash2, X } from 'lucide-react';
import { t as tr, useLocale } from './i18n';
import {
  hitStroke,
  hitImage,
  isEraser,
  isPicture,
  uid,
  type Page,
  type Point,
  type Stroke,
  type Tool,
} from './model';
import { drawStroke, drawStrokes, finalInkPath } from './ink';
import type { PenDiagnostic } from './PdfSurface';
import ObjectLayer from './ObjectLayer';
import PdfTextLayer from './PdfTextLayer';
interface Props {
  page: Page;
  pdf: PDFDocumentProxy | null;
  tool: Tool;
  color: string;
  size: number;
  zoom: number;
  onChange: (page: Page) => void;
  onDiagnostic: (d: PenDiagnostic) => void;
  onContext: (x: number, y: number) => void;
  onEditObject: (id: string) => void;
  focusObjectId: string | null;
  viewport: RefObject<HTMLElement | null>;
  active?: boolean;
  onActivate?: () => void;
  reading?: boolean;
}
const StaticInk = memo(function StaticInk({ page }: { page: Page }) {
  return (
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
  );
});
/** One editing path for single, continuous and facing pages. Coordinates use the actual page bounds. */
export default function PageEditor({
  page,
  pdf,
  tool,
  color,
  size,
  zoom,
  onChange,
  onDiagnostic,
  onContext,
  onEditObject,
  focusObjectId,
  viewport,
  active = true,
  onActivate,
  reading = false,
}: Props) {
  useLocale();
  const root = useRef<HTMLDivElement>(null),
    ink = useRef<HTMLCanvasElement>(null),
    live = useRef<HTMLCanvasElement>(null);
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
  useEffect(() => {
    if (!active) setSelected([]);
  }, [active]);
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
        !active ||
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
  }, [tool, selected, page, active]);
  useEffect(() => {
    const i = page.images.find((i) => i.id === focusObjectId);
    if (i && active) {
      setSelected([i.id]);
    }
  }, [focusObjectId, active]);
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
  const penTime = useRef(-Infinity),
    frame = useRef(0),
    diagTime = useRef(0);
  const redraw = (strokes = pageRef.current.strokes) => {
    const c = ink.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const ratio = c.width / pageRef.current.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawStrokes(ctx, strokes);
  };
  const prepareCanvas = (canvas: HTMLCanvasElement) => {
    const ratio = Math.min(2, Math.sqrt(4000000 / (page.width * page.height)));
    const width = Math.ceil(page.width * ratio),
      height = Math.ceil(page.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };
  useEffect(() => {
    if (ink.current) {
      prepareCanvas(ink.current);
      redraw(page.strokes);
    }
  }, [page]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );
  const point = (e: PointerEvent): Point => {
    const r = root.current!.getBoundingClientRect();
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
      const canvas = live.current!;
      if (stroke.current || erased.current) prepareCanvas(canvas);
      const ctx = canvas.getContext('2d')!;
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
    ) {
      e.stopPropagation();
      return;
    }
    if (e.pointerType === 'touch' || (tool === 'hand' && !isEraser(e)) || e.button === 1) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (drawingPointer.current !== null) return;
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
    if (drawingPointer.current !== e.pointerId) return;
    e.stopPropagation();
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const event of samples.length ? samples : [e.nativeEvent]) sample(event);
    queueInk();
  };
  const end = (e: ReactPointerEvent, cancel = false) => {
    if (drawingPointer.current !== e.pointerId) return;
    e.stopPropagation();
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
    <>
      <div
        className={`page-editor tool-${tool}`}
        ref={root}
        data-pending-erase={pendingCount}
        onPointerDownCapture={(e) => {
          if (e.pointerType !== 'touch') onActivate?.();
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(e) => end(e)}
        onPointerCancel={(e) => end(e, true)}
        onLostPointerCapture={(e) => end(e, true)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContext(e.clientX, e.clientY);
        }}
      >
        <ObjectLayer
          page={page}
          active={tool === 'object'}
          zoom={zoom}
          selected={active ? selected : []}
          onSelect={setSelected}
          onChange={onChange}
        />
        {reading ? <StaticInk page={page} /> : <canvas className="ink-layer" ref={ink} />}
        <canvas className="live-layer" ref={live} width={1} height={1} />
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
      {active &&
        tool === 'object' &&
        selected.length > 0 &&
        viewport.current?.parentElement &&
        createPortal(
          <div className="object-inspector" onPointerDown={(e) => e.stopPropagation()}>
            <span>
              {selectedImage
                ? selectedImage.kind === 'text'
                  ? tr('文本框')
                  : isPicture(selectedImage)
                    ? tr('图片')
                    : selectedImage.kind === 'sketch'
                      ? tr('草图')
                      : tr('公式')
                : tr('已选择 {0} 个对象', selected.length)}{' '}
              {tr('· 拖动移动，边角缩放')}
            </span>
            {selectedImage && (
              <button
                aria-label={
                  selectedImage.kind === 'text'
                    ? tr('编辑选中文本框')
                    : isPicture(selectedImage)
                      ? tr('编辑选中图片')
                      : selectedImage.kind === 'sketch'
                        ? tr('编辑选中草图')
                        : tr('编辑选中公式')
                }
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
          </div>,
          viewport.current.parentElement,
        )}
    </>
  );
}
