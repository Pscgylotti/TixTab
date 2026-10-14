import {
  memo,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  Pencil,
  Trash2,
  X,
  Copy,
  Scissors,
  ClipboardPaste,
  Layers,
  Group,
  Ungroup,
} from 'lucide-react';
import { createObjectGroup, mergePageObjects, ungroupPageObject } from './objectGroup';
import { copyObjects, pasteObjectsFromButton } from './objectClipboard';
import type { ObjectOrder } from './objectSelection';
import { inkLayerIndex, reorderPageLayers, removePageImages } from './pageLayers';
import { t as tr, useLocale } from './i18n';
import { performanceLedger, performanceOutcome, type PerformanceFinish } from './performanceLedger';
import {
  hitStroke,
  hitImage,
  isEraser,
  isPicture,
  uid,
  type Page,
  type Point,
  type Stroke,
  type PlacedImage,
  type Tool,
} from './model';
import { drawStroke, finalInkPath, cullingInkBounds } from './ink';
import type { ForegroundClip } from './foregroundViewport';
import { useForegroundViewport } from './useForegroundViewport';
import { CommittedInk } from './committedInk';
import { SpatialIndex, imageBounds, sweptBounds } from './spatialIndex';
import type { PenDiagnostic } from './PdfSurface';
import ObjectLayer from './ObjectLayer';
import GroupHierarchy from './GroupHierarchy';
import PdfTextLayer from './PdfTextLayer';
import PdfNavigationLayer from './PdfNavigationLayer';
import InkSelectionLayer from './InkSelectionLayer';
import ReviewLayer from './ReviewLayer';
import { useAppearance, renderPolicy } from './appearance';
import { lazy, Suspense } from 'react';
const NativePdfLayer = lazy(() => import('./NativePdfLayer'));
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
  focusObjectId: string | string[] | null;
  viewport: RefObject<HTMLElement | null>;
  active?: boolean;
  onActivate?: () => void;
  reading?: boolean;
  viewKey?: string | number;
}
const StaticInk = memo(function StaticInk({ page, clip }: { page: Page; clip: ForegroundClip }) {
  const index = useRef<SpatialIndex<Stroke> | null>(null);
  // Keep intrinsic path elements stable while the viewport changes. This cache
  // belongs to this mounted layer, so element owners cannot retain old pages
  // through a global stroke cache; deleted immutable strokes can be collected.
  const elements = useRef(new WeakMap<Stroke, ReactElement>());
  index.current ??= new SpatialIndex<Stroke>(cullingInkBounds);
  const visible = useMemo(() => {
    if (clip === undefined) return page.strokes;
    index.current!.update(page.strokes);
    return clip === false ? [] : index.current!.search(clip);
  }, [page.strokes, clip]);
  const paths = useMemo(
    () =>
      visible.map((s) => {
        let element = elements.current.get(s);
        if (!element) {
          element = (
            <path
              key={s.id}
              d={finalInkPath(s)}
              fill={s.color}
              opacity={s.tool === 'highlighter' ? 0.28 : s.tool === 'pencil' ? 0.65 : 1}
            />
          );
          elements.current.set(s, element);
        }
        return element;
      }),
    [visible],
  );
  return (
    <svg
      viewBox={`0 0 ${page.width} ${page.height}`}
      className="reading-ink"
      data-total-strokes={page.strokes.length}
      data-visible-strokes={visible.length}
      style={{ zIndex: inkLayerIndex(page) * 2 + 1 }}
    >
      {paths}
    </svg>
  );
});
/** Busy pages draw only the foreground inside the viewport; others never need
 * to hear about panning at all. */
export function clipsForeground(page: Page, reading: boolean) {
  return page.images.length >= 48 || (reading && page.strokes.length >= 256);
}
/** One editing path for single, continuous and facing pages. Coordinates use the actual page bounds. */
export default memo(PageEditor);
function PageEditor({
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
  viewKey,
}: Props) {
  useLocale();
  const { memoryMode } = useAppearance();
  const root = useRef<HTMLDivElement>(null),
    ink = useRef<HTMLCanvasElement>(null),
    live = useRef<HTMLCanvasElement>(null);
  const clip = useForegroundViewport(
    root,
    viewport,
    page.width,
    page.height,
    viewKey,
    clipsForeground(page, reading),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [inkSelected, setInkSelected] = useState(false);
  const [clipboardError, setClipboardError] = useState('');
  const clipboardBusy = useRef(false);
  const [groupBusy, setGroupBusy] = useState(false);
  const grouping = useRef(false),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const [orderOpen, setOrderOpen] = useState(false);
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
    setInkSelected(false);
    setOrderOpen(false);
    setClipboardError('');
  }, [page.id, tool]);
  useEffect(() => {
    if (!active) {
      setSelected([]);
      setInkSelected(false);
    }
  }, [active]);
  const deleteSelected = () => {
    if (selected.length) {
      onChange(removePageImages(page, selected));
      setSelected([]);
    }
  };
  const groupSelected = async () => {
    if (grouping.current) return;
    grouping.current = true;
    setGroupBusy(true);
    setClipboardError('');
    const original = page;
    try {
      const group = await createObjectGroup(original, selected);
      if (!alive.current || pageRef.current !== original) return;
      onChange(mergePageObjects(original, selected, group));
      setSelected([group.id]);
    } catch (error) {
      if (alive.current)
        setClipboardError(
          tr(
            error instanceof Error && error.message === 'group-limit'
              ? '组合最多支持 8 层和 1000 个子对象，原对象已保留。'
              : '组合失败，原对象已保留。',
          ),
        );
    } finally {
      grouping.current = false;
      if (alive.current) setGroupBusy(false);
    }
  };
  const ungroupSelected = () => {
    if (!selectedImage?.group) return;
    const result = ungroupPageObject(page, selectedImage);
    onChange(result.page);
    setSelected(result.ids);
  };
  const copySelected = async (cut = false) => {
    if (clipboardBusy.current) return;
    clipboardBusy.current = true;
    setClipboardError('');
    const ids = [...selected],
      originalPage = page;
    try {
      await copyObjects(originalPage, ids);
      // A delayed clipboard permission prompt must not delete objects on a newly active page.
      if (cut && pageRef.current.id === originalPage.id) {
        onChange(removePageImages(pageRef.current, ids));
        setSelected((current) => current.filter((id) => !ids.includes(id)));
      }
    } catch {
      setClipboardError(tr('复制失败，所选对象已保留。'));
    } finally {
      clipboardBusy.current = false;
    }
  };
  const orderSelected = (order: ObjectOrder) => {
    const next = reorderPageLayers(page, selected, order, inkSelected);
    if (next !== page) onChange(next);
    if (order === 'front' || order === 'back') setOrderOpen(false);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        !active ||
        tool !== 'object' ||
        (!selected.length && !inkSelected) ||
        (e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]') ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      if (e.key === 'Delete' && selected.length) {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === 'Escape') {
        setSelected([]);
        setInkSelected(false);
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (selected.length && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
          e.preventDefault();
          void copySelected(e.key.toLowerCase() === 'x');
        } else if (e.code === 'BracketRight' || e.code === 'BracketLeft') {
          e.preventDefault();
          orderSelected(
            e.code === 'BracketRight'
              ? e.shiftKey
                ? 'front'
                : 'forward'
              : e.shiftKey
                ? 'back'
                : 'backward',
          );
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [tool, selected, inkSelected, page, active]);
  useEffect(() => {
    const ids = Array.isArray(focusObjectId) ? focusObjectId : [focusObjectId];
    const chosen = page.images.filter((i) => ids.includes(i.id)).map((i) => i.id);
    if (chosen.length && active) {
      setSelected(chosen);
      setInkSelected(false);
    }
  }, [focusObjectId, active]);
  const pageRef = useRef(page);
  pageRef.current = page;
  const stroke = useRef<Stroke | null>(null),
    erased = useRef<{
      strokes: Set<string>;
      images: Set<string>;
      highlights: Map<string, Stroke>;
    } | null>(null),
    eraseLast = useRef<Point | null>(null),
    drawingPointer = useRef<number | null>(null);
  const [pendingImages, setPendingImages] = useState<string[]>([]),
    [pendingCount, setPendingCount] = useState(0);
  const penTime = useRef(-Infinity),
    frame = useRef(0),
    diagTime = useRef(0);
  const committed = useRef<CommittedInk | null>(null);
  if (!committed.current) committed.current = new CommittedInk();
  const imageIndex = useRef<SpatialIndex<PlacedImage> | null>(null);
  if (!imageIndex.current) imageIndex.current = new SpatialIndex<PlacedImage>(imageBounds);
  const prepareCanvas = (canvas: HTMLCanvasElement) => {
    const ratio = Math.min(
      renderPolicy().minimal ? 1 : 2,
      Math.sqrt((renderPolicy().minimal ? 1000000 : 4000000) / (page.width * page.height)),
    );
    const width = Math.ceil(page.width * ratio),
      height = Math.ceil(page.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };
  useEffect(() => {
    if (ink.current) committed.current!.paint(ink.current, page);
    else committed.current!.reset();
  }, [page.id, page.width, page.height, page.strokes, reading, memoryMode]);
  useEffect(() => {
    const canvas = ink.current;
    if (!canvas) return;
    const lost = () => committed.current!.reset();
    const restored = () => committed.current!.paint(canvas, pageRef.current);
    canvas.addEventListener('contextlost', lost);
    canvas.addEventListener('contextrestored', restored);
    return () => {
      canvas.removeEventListener('contextlost', lost);
      canvas.removeEventListener('contextrestored', restored);
    };
  }, [reading]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      paintFinish.current?.('cancelled');
      paintFinish.current = undefined;
      frame.current = 0;
    },
    [],
  );
  // One layout read serves every coalesced sample of the same pointer event.
  const point = (e: PointerEvent, r = root.current!.getBoundingClientRect()): Point => {
    return [
      ((e.clientX - r.left) / r.width) * page.width,
      ((e.clientY - r.top) / r.height) * page.height,
      e.pointerType === 'pen' ? Math.max(0.01, e.pressure) : 0.5,
    ];
  };
  // Painting runs every frame of a stroke; keep the same array while the set of
  // objects marked for erasing is unchanged, so React has nothing to re-render.
  const showPending = (next: string[]) =>
    setPendingImages((previous) =>
      previous.length === next.length && previous.every((id, i) => id === next[i])
        ? previous
        : next,
    );
  const queueInk = () => {
    if (frame.current) return;
    paintFinish.current = performanceLedger?.begin('ink-paint');
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const finish = paintFinish.current;
      paintFinish.current = undefined;
      try {
        const canvas = live.current!;
        if (renderPolicy().minimal && !stroke.current && !erased.current) {
          canvas.width = canvas.height = 1;
          finish?.();
          return;
        }
        if (stroke.current || erased.current) prepareCanvas(canvas);
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const r = canvas.width / pageRef.current.width;
        ctx.setTransform(r, 0, 0, r, 0, 0);
        const pending = erased.current;
        if (pending) {
          for (const s of pending.highlights.values()) drawStroke(ctx, s, true);
          showPending([...pending.images]);
          setPendingCount(pending.images.size + pending.strokes.size);
        } else {
          showPending([]);
          setPendingCount(0);
        }
        if (stroke.current) drawStroke(ctx, stroke.current);
        finish?.();
      } catch (error) {
        finish?.(performanceOutcome(error));
        throw error;
      }
    });
  };
  const paintFinish = useRef<PerformanceFinish | undefined>(undefined);
  const sample = (e: PointerEvent, rect?: DOMRect) => {
    const p = point(e, rect);
    if (erased.current) {
      const from = eraseLast.current ?? p,
        radius = Math.max(8, size * 2),
        box = sweptBounds(from, p, radius);
      for (const s of committed.current!.candidates(pageRef.current.strokes, box))
        if (!erased.current.strokes.has(s.id) && hitStroke(s, from, p, radius)) {
          erased.current.strokes.add(s.id);
          erased.current.highlights.set(s.id, {
            ...s,
            tool: 'ballpoint',
            color: '#e05b62',
            size: s.size + 3,
          });
        }
      imageIndex.current!.update(pageRef.current.images);
      for (const image of imageIndex.current!.search(box, false))
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
    if (tool === 'pdf-edit' || tool === 'review') return;
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
      erased.current = { strokes: new Set(), images: new Set(), highlights: new Map() };
      eraseLast.current = point(e.nativeEvent);
    } else stroke.current = { id: uid(), tool, color, size, points: [] };
    sample(e.nativeEvent);
    queueInk();
  };
  const move = (e: ReactPointerEvent) => {
    if (e.pointerType === 'pen') penTime.current = performance.now();
    if (drawingPointer.current !== e.pointerId) return;
    e.stopPropagation();
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [],
      rect = root.current!.getBoundingClientRect();
    for (const event of samples.length ? samples : [e.nativeEvent]) sample(event, rect);
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
          ...removePageImages(pageRef.current, [...pending.images]),
          strokes: pageRef.current.strokes.filter((s) => !pending.strokes.has(s.id)),
        });
      }
    }
    stroke.current = null;
    erased.current = null;
    eraseLast.current = null;
    drawingPointer.current = null;
    showPending([]);
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
          index={imageIndex.current}
          clip={clip}
          pinned={pendingImages}
          active={tool === 'object'}
          zoom={zoom}
          selected={active ? selected : []}
          onSelect={(ids) => {
            setSelected(ids);
            setInkSelected(false);
          }}
          onChange={onChange}
        />
        {reading ? (
          <StaticInk page={page} clip={clip} />
        ) : (
          <canvas className="ink-layer" ref={ink} style={{ zIndex: inkLayerIndex(page) * 2 + 1 }} />
        )}
        <canvas
          className="live-layer"
          ref={live}
          width={1}
          height={1}
          style={{ zIndex: pendingCount > 0 ? 10002 : inkLayerIndex(page) * 2 + 1 }}
        />
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
        {tool === 'select' && <PdfTextLayer pdf={pdf} sourceIndex={page.sourceIndex} page={page} />}
        <PdfNavigationLayer
          page={page}
          pdf={pdf}
          tool={tool}
          reading={!!reading}
          clip={clip}
          zoom={zoom}
        />
        <InkSelectionLayer
          page={page}
          tool={tool}
          zoom={zoom}
          root={root}
          viewport={viewport}
          onChange={onChange}
          onActivate={onActivate}
        />
        {page.reviews?.length || tool === 'review' ? (
          <ReviewLayer page={page} tool={tool} zoom={zoom} onChange={onChange} />
        ) : null}
        {tool === 'pdf-edit' && (
          <Suspense fallback={null}>
            <NativePdfLayer page={page} zoom={zoom} active={active} />
          </Suspense>
        )}
      </div>
      {active &&
        tool === 'object' &&
        (selected.length > 0 || inkSelected || page.strokes.length > 0) &&
        viewport.current?.parentElement &&
        createPortal(
          <div className="object-inspector" onPointerDown={(e) => e.stopPropagation()}>
            <span>
              {inkSelected
                ? tr('手写层')
                : selectedImage
                  ? selectedImage.group
                    ? tr('组合对象')
                    : selectedImage.kind === 'text'
                      ? tr('文本框')
                      : isPicture(selectedImage)
                        ? tr('图片')
                        : selectedImage.kind === 'sketch'
                          ? tr('草图')
                          : tr('公式')
                  : selected.length
                    ? tr('已选择 {0} 个对象', selected.length)
                    : tr('选择对象或手写层')}
            </span>
            {selectedImage && !selectedImage.group && (
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
            {selected.length > 1 && (
              <button
                disabled={groupBusy}
                aria-label={tr('组合选中对象')}
                title={tr('组合选中对象')}
                onClick={() => void groupSelected()}
              >
                <Group size={15} />
                {tr(groupBusy ? '正在组合…' : '组合')}
              </button>
            )}
            {selectedImage?.group && (
              <GroupHierarchy key={selectedImage.id} image={selectedImage} />
            )}
            {selectedImage?.group && (
              <button
                aria-label={tr('取消对象组合')}
                title={tr('解除组合只展开当前一层，内部组合会保留。')}
                onClick={ungroupSelected}
              >
                <Ungroup size={15} />
                {tr('解除一层')}
              </button>
            )}
            {!!selected.length && (
              <>
                <button
                  aria-label={tr('剪切选中对象')}
                  title={`${tr('剪切选中对象')} (Ctrl+X)`}
                  onClick={() => void copySelected(true)}
                >
                  <Scissors size={15} />
                </button>
                <button
                  aria-label={tr('复制选中对象')}
                  title={`${tr('复制选中对象')} (Ctrl+C)`}
                  onClick={() => void copySelected()}
                >
                  <Copy size={15} />
                </button>
              </>
            )}
            <button
              aria-label={tr('粘贴对象')}
              title={`${tr('粘贴对象')} (Ctrl+V)`}
              onClick={() => {
                setClipboardError('');
                void pasteObjectsFromButton().catch(() =>
                  setClipboardError(tr('无法读取对象剪贴板，请使用 Ctrl+V。')),
                );
              }}
            >
              <ClipboardPaste size={15} />
            </button>
            {page.strokes.length > 0 && (
              <button
                aria-label={tr('选择手写层')}
                aria-pressed={inkSelected}
                onClick={() => {
                  setSelected([]);
                  setInkSelected(true);
                  setOrderOpen(true);
                }}
              >
                <Pencil size={15} />
                {tr('手写层')}
              </button>
            )}
            {(selected.length > 0 || inkSelected) && (
              <div className="object-order">
                <button
                  aria-label={tr('排列顺序')}
                  aria-expanded={orderOpen}
                  onClick={() => setOrderOpen((v) => !v)}
                >
                  <Layers size={15} />
                </button>
                {orderOpen && (
                  <div className="object-order-menu" role="group" aria-label={tr('排列顺序')}>
                    {(
                      [
                        ['front', '置于顶层'],
                        ['forward', '上移一层'],
                        ['backward', '下移一层'],
                        ['back', '置于底层'],
                      ] as const
                    ).map(([order, label]) => (
                      <button key={order} onClick={() => orderSelected(order)}>
                        {tr(label)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!!selected.length && (
              <button aria-label={tr('删除选中对象')} onClick={deleteSelected}>
                <Trash2 size={15} />
              </button>
            )}
            {(selected.length > 0 || inkSelected) && (
              <button
                aria-label={tr('取消对象选择')}
                onClick={() => {
                  setSelected([]);
                  setInkSelected(false);
                  setOrderOpen(false);
                }}
              >
                <X size={15} />
              </button>
            )}
            {clipboardError && (
              <div className="object-clipboard-error" role="status">
                {clipboardError}
              </div>
            )}
          </div>,
          viewport.current.parentElement,
        )}
    </>
  );
}
