import LocalImagePickerLayer from './LocalImagePickerLayer';
import MusicScoreLayer from './MusicScoreLayer';
import { ScratchInkContext } from './ScratchInkContext';
import {
  memo,
  useMemo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { getPressureMapper } from './pressureCurve';
import type { PDFDocumentProxy } from './pdfTypes';
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
  RotateCcw,
  RotateCw,
  Crop,
} from 'lucide-react';
import { createObjectGroup, mergePageObjects, ungroupPageObject } from './objectGroup';
import { copyObjects, pasteObjectsFromButton, containsScratchPage } from './objectClipboard';
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
import { finalInkPath, cullingInkBounds, inkPaperRadius } from './ink';
import { paintLiveInk, releaseLiveInk } from './liveInk';
import { InkSampleClock } from './inkSampling';
import { savedInkSize } from './inkPreferences';
import { eraserPaperRadius } from './eraserRadius';
import type { ForegroundClip } from './foregroundViewport';
import { useForegroundViewport } from './useForegroundViewport';
import { CommittedInk, committedInkRatio } from './committedInk';
import { SpatialIndex, imageBounds, sweptBounds } from './spatialIndex';
import type { PenDiagnostic } from './PdfSurface';
import ObjectLayer from './ObjectLayer';
import GroupHierarchy from './GroupHierarchy';
import PdfTextLayer from './PdfTextLayer';
import PdfNavigationLayer from './PdfNavigationLayer';
import PdfOriginalImages from './PdfOriginalImages';
import InkSelectionLayer from './InkSelectionLayer';
import { selectInk } from './inkSelection';
import ReviewLayer from './ReviewLayer';
import { useAppearance } from './appearance';
import { lazy, Suspense } from 'react';
const ImageCropDialog = lazy(() => import('./ImageCropDialog'));
const ColorKeyDialog = lazy(() => import('./ColorKeyDialog'));
const PdfEditLayer = lazy(() => import('./PdfEditLayer'));
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
  forceClip?: boolean;
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
  forceClip = false,
}: Props) {
  useLocale();
  const routeStroke = useContext(ScratchInkContext);
  const { memoryMode } = useAppearance();
  const [dpr, setDpr] = useState(window.devicePixelRatio);
  useEffect(() => {
    const resize = () => setDpr(window.devicePixelRatio);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  // Keep completed ink sharp too: beyond the retained raster's density use
  // vector paths, without allocating a full-page high-resolution canvas.
  const vectorInk = reading || zoom * dpr > committedInkRatio(page);
  const root = useRef<HTMLDivElement>(null),
    ink = useRef<HTMLCanvasElement>(null),
    live = useRef<HTMLCanvasElement>(null);
  const clip = useForegroundViewport(
    root,
    viewport,
    page.width,
    page.height,
    viewKey,
    forceClip || clipsForeground(page, vectorInk),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [inkSelected, setInkSelected] = useState(false);
  const [selectedReview, setSelectedReview] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedReview) return;
    setSelected([]);
    setInkSelected(false);
    selectInk(page.id, []);
  }, [selectedReview]);
  useEffect(() => {
    if (selectedReview && !page.reviews?.some((n) => n.id === selectedReview))
      setSelectedReview(null);
  }, [page.reviews, selectedReview]);
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
      setSelectedReview(null);
    }
  }, [active]);
  const deleteSelected = () => {
    if (selectedReview) {
      onChange({ ...page, reviews: page.reviews?.filter((n) => n.id !== selectedReview) });
      setSelectedReview(null);
    } else if (selected.length) {
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
      setClipboardError(
        tr(
          originalPage.images.some((i) => ids.includes(i.id) && containsScratchPage(i))
            ? '草稿纸中的 PDF 页面不能复制或剪切'
            : '复制失败，所选对象已保留。',
        ),
      );
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
        (!selected.length && !inkSelected && !selectedReview) ||
        (e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]') ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      if (e.key === 'Delete' && (selected.length || selectedReview)) {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === 'Escape') {
        setSelected([]);
        setInkSelected(false);
        setSelectedReview(null);
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
  }, [tool, selected, inkSelected, selectedReview, page, active]);
  useEffect(() => {
    const ids = Array.isArray(focusObjectId) ? focusObjectId : [focusObjectId];
    const chosen = page.images.filter((i) => ids.includes(i.id)).map((i) => i.id);
    if (chosen.length && active) {
      setSelected(chosen);
      setInkSelected(false);
      setSelectedReview(null);
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
  const pressureMapper = useRef(getPressureMapper());
  // Keep the routing chosen at pointer-down through capture, rerenders and
  // unmount. The context value itself changes whenever the parent renders.
  const eraseRoute = useRef<typeof routeStroke>(null);
  const sampleClock = useRef(new InkSampleClock());
  const tailEraser = useRef(false),
    eraserCursor = useRef<HTMLDivElement>(null);
  const eraserRadiusAt = (e: PointerEvent) =>
    eraserPaperRadius(
      tool === 'eraser' ? size : savedInkSize('eraser'),
      pressureMapper.current(e.pressure),
      e.pointerType === 'pen',
    );
  const hideEraserCursor = () => {
    if (eraserCursor.current) eraserCursor.current.style.display = 'none';
  };
  const previewEraser = (e: PointerEvent) => {
    const circle = eraserCursor.current;
    if (!circle) return;
    const erasing = tool === 'eraser' || tailEraser.current || isEraser(e);
    const writing = ['pen', 'ballpoint', 'pencil', 'highlighter'].includes(tool);
    if (e.pointerType === 'touch' || (!erasing && (!writing || e.altKey || !!(e.buttons & 2)))) {
      hideEraserCursor();
      return;
    }
    const pressure =
      e.pointerType === 'pen' && e.pressure > 0
        ? Math.max(0.01, pressureMapper.current(e.pressure))
        : 0.5;
    const paperRadius = erasing ? eraserRadiusAt(e) : inkPaperRadius(tool, size, pressure);
    const radius = paperRadius * (root.current!.getBoundingClientRect().width / page.width);
    circle.className = erasing ? 'pdf-eraser-cursor' : 'pdf-ink-cursor';
    circle.style.display = 'block';
    circle.style.width = circle.style.height = `${radius * 2}px`;
    circle.style.transform = `translate(${e.clientX - radius}px,${e.clientY - radius}px)`;
    circle.dataset.screenRadius = String(radius);
    circle.dataset.paperRadius = String(paperRadius);
  };
  useEffect(() => {
    hideEraserCursor();
    window.addEventListener('blur', hideEraserCursor);
    return () => {
      window.removeEventListener('blur', hideEraserCursor);
      hideEraserCursor();
    };
  }, [tool, page.id]);
  const [pendingImages, setPendingImages] = useState<string[]>([]),
    [pendingCount, setPendingCount] = useState(0);
  const penTime = useRef(-Infinity),
    frame = useRef(0),
    diagTime = useRef(0);
  const committed = useRef<CommittedInk | null>(null);
  if (!committed.current) committed.current = new CommittedInk();
  const imageIndex = useRef<SpatialIndex<PlacedImage> | null>(null);
  if (!imageIndex.current) imageIndex.current = new SpatialIndex<PlacedImage>(imageBounds);
  useEffect(() => {
    if (ink.current) committed.current!.paint(ink.current, page);
    else committed.current!.reset();
  }, [page.id, page.width, page.height, page.strokes, vectorInk, memoryMode]);
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
      // Switching to vector ink/unmounting must release the old raster now,
      // rather than retaining a detached GPU texture until garbage collection.
      canvas.width = canvas.height = 1;
      committed.current!.reset();
    };
  }, [vectorInk]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      paintFinish.current?.('cancelled');
      paintFinish.current = undefined;
      frame.current = 0;
      eraseRoute.current?.finishErase(pageRef.current.id, true);
      eraseRoute.current = null;
    },
    [],
  );
  // One layout read serves every coalesced sample of the same pointer event.
  const point = (e: PointerEvent, r = root.current!.getBoundingClientRect()): Point => {
    return [
      ((e.clientX - r.left) / r.width) * page.width,
      ((e.clientY - r.top) / r.height) * page.height,
      e.pointerType === 'pen' ? Math.max(0.01, pressureMapper.current(e.pressure)) : 0.5,
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
        const pending = erased.current;
        if (pending && eraseRoute.current) {
          showPending([]);
          setPendingCount(eraseRoute.current.previewErase(pageRef.current.id));
          releaseLiveInk(canvas);
          finish?.();
          return;
        } else if (pending) {
          showPending([...pending.images]);
          setPendingCount(pending.images.size + pending.strokes.size);
        } else {
          showPending([]);
          setPendingCount(0);
        }
        const strokes = stroke.current
          ? [stroke.current]
          : [...(pending?.highlights.values() ?? [])];
        if (routeStroke && root.current && stroke.current) {
          routeStroke.preview(
            pageRef.current,
            stroke.current,
            root.current.getBoundingClientRect(),
          );
          releaseLiveInk(canvas);
        } else {
          if (routeStroke && root.current)
            routeStroke.preview(pageRef.current, null, root.current.getBoundingClientRect());
          if (strokes.length && root.current && viewport.current)
            paintLiveInk(
              canvas,
              pageRef.current,
              strokes,
              root.current.getBoundingClientRect(),
              viewport.current.getBoundingClientRect(),
              window.devicePixelRatio,
            );
          else releaseLiveInk(canvas);
        }
        finish?.();
      } catch (error) {
        finish?.(performanceOutcome(error));
        throw error;
      }
    });
  };
  const paintFinish = useRef<PerformanceFinish | undefined>(undefined);
  const sample = (e: PointerEvent, rect?: DOMRect) => {
    if (!sampleClock.current.accept(e.timeStamp, e.clientX, e.clientY, e.pressure)) return;
    const bounds = rect ?? root.current!.getBoundingClientRect();
    const p = point(e, bounds);
    if (erased.current) {
      const from = eraseLast.current ?? p,
        radius = eraserRadiusAt(e),
        box = sweptBounds(from, p, radius);
      if (eraseRoute.current) {
        eraseRoute.current.sampleErase(pageRef.current, from, p, radius, bounds);
      } else {
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
      }
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
    sampleClock.current.reset();
    pressureMapper.current = getPressureMapper();
    tailEraser.current = isEraser(e);
    previewEraser(e.nativeEvent);
    if (tool === 'eraser' || isEraser(e)) {
      eraseRoute.current = routeStroke;
      erased.current = { strokes: new Set(), images: new Set(), highlights: new Map() };
      eraseLast.current = point(e.nativeEvent);
    } else stroke.current = { id: uid(), tool, color, size, points: [] };
    sample(e.nativeEvent);
    queueInk();
  };
  const collect = (e: PointerEvent) => {
    if (drawingPointer.current !== e.pointerId) return;
    const samples = e.getCoalescedEvents?.() ?? [],
      rect = root.current!.getBoundingClientRect();
    for (const event of samples.length ? samples : [e]) sample(event, rect);
    queueInk();
  };
  const rawCollector = useRef(collect);
  rawCollector.current = collect;
  useEffect(() => {
    const element = root.current!;
    const raw = (event: Event) => {
      if (event instanceof PointerEvent && event.pointerType === 'pen') rawCollector.current(event);
    };
    element.addEventListener('pointerrawupdate', raw);
    return () => element.removeEventListener('pointerrawupdate', raw);
  }, []);
  const move = (e: ReactPointerEvent) => {
    previewEraser(e.nativeEvent);
    if (e.pointerType === 'pen') penTime.current = performance.now();
    if (drawingPointer.current !== e.pointerId) return;
    e.stopPropagation();
    collect(e.nativeEvent);
  };
  const end = (e: ReactPointerEvent, cancel = false) => {
    if (drawingPointer.current !== e.pointerId) return;
    e.stopPropagation();
    if (!cancel && erased.current) sample(e.nativeEvent);
    if (erased.current && eraseRoute.current)
      eraseRoute.current.finishErase(pageRef.current.id, cancel);
    eraseRoute.current = null;
    if (!cancel) {
      // Pointer-up pressure is zero; keep the last contact pressure to avoid an artificial taper.
      if (stroke.current) {
        if (routeStroke && root.current)
          routeStroke.commit(pageRef.current, stroke.current, root.current.getBoundingClientRect());
        else
          onChange({ ...pageRef.current, strokes: [...pageRef.current.strokes, stroke.current] });
      } else if (erased.current && (erased.current.strokes.size || erased.current.images.size)) {
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
    tailEraser.current = false;
    hideEraserCursor();
    showPending([]);
    setPendingCount(0);
    queueInk();
  };
  const [colorKeyImage, setColorKeyImage] = useState<PlacedImage | null>(null);
  const [cropImage, setCropImage] = useState<PlacedImage | null>(null);
  const rotateImage = (turn: number) => {
    if (!selectedImage) return;
    const scale = Math.min(1, page.width / selectedImage.height, page.height / selectedImage.width);
    const width = selectedImage.height * scale,
      height = selectedImage.width * scale;
    const image = {
      ...selectedImage,
      rotation: (((selectedImage.rotation ?? 0) + turn + 360) % 360) as PlacedImage['rotation'],
      width,
      height,
      x: Math.max(
        0,
        Math.min(page.width - width, selectedImage.x + (selectedImage.width - width) / 2),
      ),
      y: Math.max(
        0,
        Math.min(page.height - height, selectedImage.y + (selectedImage.height - height) / 2),
      ),
    };
    onChange({ ...page, images: page.images.map((i) => (i.id === image.id ? image : i)) });
  };
  return (
    <>
      {cropImage && (
        <Suspense fallback={null}>
          <ImageCropDialog
            image={cropImage}
            onClose={() => setCropImage(null)}
            onApply={(image) => {
              onChange({
                ...page,
                images: page.images.map((i) => (i.id === image.id ? image : i)),
              });
              setCropImage(null);
            }}
          />
        </Suspense>
      )}
      {colorKeyImage && (
        <Suspense fallback={null}>
          <ColorKeyDialog
            image={colorKeyImage}
            onClose={() => setColorKeyImage(null)}
            onApply={(image) => {
              onChange({
                ...page,
                images: page.images.map((i) => (i.id === image.id ? image : i)),
              });
              setColorKeyImage(null);
            }}
          />
        </Suspense>
      )}
      {createPortal(
        <div
          ref={eraserCursor}
          className="pdf-eraser-cursor"
          aria-hidden="true"
          style={{ display: 'none' }}
        />,
        document.body,
      )}
      <div
        className={`page-editor tool-${tool}`}
        ref={root}
        data-pending-erase={pendingCount}
        onPointerDownCapture={(e) => {
          if (e.pointerType !== 'touch') onActivate?.();
        }}
        onPointerDown={down}
        onPointerEnter={(e) => previewEraser(e.nativeEvent)}
        onPointerMove={move}
        onPointerLeave={hideEraserCursor}
        onPointerUp={(e) => end(e)}
        onPointerCancel={(e) => end(e, true)}
        onLostPointerCapture={(e) => end(e, true)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContext(e.clientX, e.clientY);
        }}
      >
        <LocalImagePickerLayer page={page} pdf={pdf} />
        <MusicScoreLayer page={page} />
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
            setSelectedReview(null);
          }}
          onChange={onChange}
        />
        {vectorInk ? (
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
        <PdfOriginalImages
          pdf={pdf}
          sourceIndex={page.sourceIndex}
          enabled={tool === 'hand'}
          pageId={page.id}
          bitmapOcr={page.bitmapOcr}
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
          <ReviewLayer
            page={page}
            tool={tool}
            zoom={zoom}
            onChange={onChange}
            selected={selectedReview}
            onSelect={setSelectedReview}
          />
        ) : null}
        {tool === 'pdf-edit' && (
          <Suspense fallback={null}>
            <PdfEditLayer
              page={page}
              zoom={zoom}
              active={active}
              host={viewport.current?.parentElement ?? null}
            />
          </Suspense>
        )}
      </div>
      {active &&
        tool === 'object' &&
        (selected.length > 0 || selectedReview || inkSelected || page.strokes.length > 0) &&
        viewport.current?.parentElement &&
        createPortal(
          <div className="object-inspector" onPointerDown={(e) => e.stopPropagation()}>
            <span>
              {selectedReview
                ? tr('便签')
                : inkSelected
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
            {selectedImage && isPicture(selectedImage) && !selectedImage.group && (
              <>
                <button
                  aria-label={tr('逆时针旋转图片')}
                  title={tr('逆时针旋转图片')}
                  onClick={() => rotateImage(-90)}
                >
                  <RotateCcw size={15} />
                </button>
                <button
                  aria-label={tr('顺时针旋转图片')}
                  title={tr('顺时针旋转图片')}
                  onClick={() => rotateImage(90)}
                >
                  <RotateCw size={15} />
                </button>
                <button
                  aria-label={tr('裁剪图片')}
                  title={tr('裁剪图片')}
                  onClick={() => setCropImage(selectedImage)}
                >
                  <Crop size={15} />
                </button>
              </>
            )}
            {selectedImage &&
              isPicture(selectedImage) &&
              !selectedImage.group &&
              !selectedImage.scratchPage && (
                <button
                  aria-label={tr('设置透明色')}
                  onClick={() => setColorKeyImage(selectedImage)}
                >
                  {tr('透明色')}
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
                  disabled={page.images.some(
                    (i) => selected.includes(i.id) && containsScratchPage(i),
                  )}
                  title={`${tr('剪切选中对象')} (Ctrl+X)`}
                  onClick={() => void copySelected(true)}
                >
                  <Scissors size={15} />
                </button>
                <button
                  aria-label={tr('复制选中对象')}
                  disabled={page.images.some(
                    (i) => selected.includes(i.id) && containsScratchPage(i),
                  )}
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
                  setSelectedReview(null);
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
            {(!!selected.length || selectedReview) && (
              <button aria-label={tr('删除选中对象')} onClick={deleteSelected}>
                <Trash2 size={15} />
              </button>
            )}
            {(selected.length > 0 || inkSelected || selectedReview) && (
              <button
                aria-label={tr('取消对象选择')}
                onClick={() => {
                  setSelected([]);
                  setSelectedReview(null);
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
