import { useContext, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowUp,
  BringToFront,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  RotateCw,
  SendToBack,
  Trash2,
} from 'lucide-react';
import { DocumentEditContext } from './DocumentEditContext';
import type { Page } from './model';
import { t, useLocale } from './i18n';
import { pdfEditErrors } from './pdfNativeTypes';
import { liftPdfObjects, listPdfObjects } from './pdfObjectsClient';
import { useAppearance } from './appearance';
import {
  reorder,
  type PdfObjectEdit,
  type PdfObjectKind,
  type PdfObjectOrder,
  type PdfPageObject,
} from './pdfiumObjects';
import {
  IDENTITY,
  alignOffsets,
  applyPolygon,
  containsPoint,
  distributeOffsets,
  multiply,
  polygonBox,
  rotateAbout,
  scaleAbout,
  toPdfSpace,
  translate,
  unionBox,
  type Affine,
  type Alignment,
} from './pdfObjectGeometry';

type Filter = 'all' | PdfObjectKind;
const FILTERS: Filter[] = ['all', 'text', 'image', 'path', 'shading', 'form'];
const FILTER_LABELS: Record<Filter, string> = {
  all: '全部',
  text: '文本',
  image: '图片',
  path: '路径',
  shading: '渐变',
  form: '表单',
};
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;
type Corner = (typeof CORNERS)[number];
interface Item {
  object: PdfPageObject;
  /** Rotated bounds in page coordinates. */
  poly: number[];
  /** left, top, right, bottom in page coordinates. */
  box: number[];
}
type Gesture =
  | { kind: 'move'; pointer: number; x: number; y: number }
  | { kind: 'scale'; pointer: number; corner: Corner; anchor: number[]; x: number; y: number }
  | { kind: 'rotate'; pointer: number; center: number[]; angle: number }
  | { kind: 'marquee'; pointer: number; x: number; y: number; add: boolean };
const errorText = (error: unknown) => {
  const code = error instanceof Error ? error.message : 'pdf-edit';
  return t(pdfEditErrors[code] || pdfEditErrors['pdf-edit']);
};
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest('input,textarea,select,[contenteditable="true"]');
let lastFilter: Filter = 'all';
interface Lift {
  only: ImageBitmap;
  except: ImageBitmap;
  /** left, top, right, bottom in page coordinates. */
  box: number[];
}
/** A lifted bitmap placed on the page; `transform` follows the gesture. */
function LiftCanvas({
  bitmap,
  box,
  transform,
}: {
  bitmap: ImageBitmap;
  box: number[];
  transform?: Affine;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current!;
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d')!.drawImage(bitmap, 0, 0);
    return () => {
      c.width = c.height = 0;
    };
  }, [bitmap]);
  const m = transform ? `matrix(${transform.join(',')}) ` : '';
  return (
    <canvas
      ref={canvas}
      className="pdf-object-lift"
      aria-hidden="true"
      style={{
        width: box[2] - box[0],
        height: box[3] - box[1],
        transform: `${m}translate(${box[0]}px, ${box[1]}px)`,
      }}
    />
  );
}

/** Foxit-style "Edit Object": select any page object (text, image, path,
 * shading, form) and move, scale, rotate, flip, restack, align or delete it.
 * Each finished action is one PDF edit, applied by PDFium and undoable.
 * Touch input is left to the page for panning; pen and mouse edit. */
export default function PdfObjectLayer({
  page,
  zoom,
  active,
  host,
  onEditText,
}: {
  page: Page;
  zoom: number;
  active: boolean;
  host: HTMLElement | null;
  onEditText: () => void;
}) {
  useLocale();
  const context = useContext(DocumentEditContext),
    source = context?.notebook.source,
    pdf = context?.pdf;
  const [view, setView] = useState<Affine | null>(null),
    [objects, setObjects] = useState<PdfPageObject[]>([]),
    // Counts object list loads; style inputs remount to show reloaded values.
    [revision, setRevision] = useState(0),
    [filter, setFilterState] = useState<Filter>(lastFilter),
    [selected, setSelected] = useState<number[]>([]),
    [hover, setHover] = useState<number | null>(null),
    [preview, setPreview] = useState<Affine | null>(null),
    [marquee, setMarquee] = useState<number[] | null>(null),
    [status, setStatus] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [lift, setLiftState] = useState<Lift | null>(null);
  const { pdfNight } = useAppearance(),
    liftToken = useRef(0);
  /** Replacing or clearing the preview also cancels any answer still on its way. */
  const setLift = (next: Lift | null, invalidate = true) => {
    if (invalidate) liftToken.current++;
    setLiftState((old) => {
      if (old && old !== next) {
        old.only.close();
        old.except.close();
      }
      return next;
    });
  };
  useEffect(() => () => setLift(null), []);
  const root = useRef<HTMLDivElement>(null),
    gesture = useRef<Gesture | null>(null),
    nextSelection = useRef<number[] | null>(null),
    nudge = useRef<{ x: number; y: number; timer?: ReturnType<typeof setTimeout> }>({ x: 0, y: 0 });
  const setFilter = (value: Filter) => {
    lastFilter = value;
    setFilterState(value);
    setSelected([]);
  };

  useEffect(() => {
    let dead = false;
    setView(null);
    if (!pdf || page.sourceIndex === null) return;
    pdf
      .getPage(page.sourceIndex + 1)
      .then((p) => {
        if (!dead) setView(p.getViewport({ scale: 1 }).transform);
      })
      .catch(() => {
        if (!dead) setStatus(t(pdfEditErrors['pdf-edit']));
      });
    return () => {
      dead = true;
    };
  }, [pdf, page.sourceIndex]);
  useEffect(() => {
    let dead = false;
    if (!active || !source || page.sourceIndex === null) {
      setObjects([]);
      setSelected([]);
      return;
    }
    setLoading(true);
    listPdfObjects(source, page.sourceIndex)
      .then((list) => {
        if (dead) return;
        setObjects(list);
        setRevision((n) => n + 1);
        setSelected(nextSelection.current ?? []);
        nextSelection.current = null;
        setPreview(null);
        setLift(null);
        setStatus('');
      })
      .catch((error) => {
        if (!dead) setStatus(errorText(error));
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [source, page.sourceIndex, active]);

  const items = useMemo<Item[]>(() => {
    if (!view) return [];
    return objects.map((object) => {
      const poly = applyPolygon(view, object.quad);
      return { object, poly, box: polygonBox(poly) };
    });
  }, [objects, view]);
  const byIndex = useMemo(() => new Map(items.map((i) => [i.object.index, i])), [items]);
  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.object.kind === filter)),
    [items, filter],
  );
  const chosen = selected.map((i) => byIndex.get(i)).filter((i): i is Item => !!i);
  const selectionBox = chosen.length ? unionBox(chosen.map((i) => i.box)) : null;

  const point = (event: { clientX: number; clientY: number }) => {
    const r = root.current!.getBoundingClientRect();
    return [
      ((event.clientX - r.left) / r.width) * page.width,
      ((event.clientY - r.top) / r.height) * page.height,
    ];
  };
  /** Topmost object under the point; thin lines get a few screen pixels of slack. */
  const hit = (x: number, y: number) => {
    const slack = 4 / zoom;
    for (let i = visible.length - 1; i >= 0; i--) {
      const { poly, box } = visible[i];
      const thin = box[2] - box[0] < slack * 2 || box[3] - box[1] < slack * 2;
      if (
        containsPoint(poly, x, y) ||
        (thin &&
          x >= box[0] - slack &&
          x <= box[2] + slack &&
          y >= box[1] - slack &&
          y <= box[3] + slack)
      )
        return visible[i];
    }
    return null;
  };

  async function run(edits: PdfObjectEdit[], selectAfter: number[]) {
    if (!context || !edits.length) {
      setPreview(null);
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      nextSelection.current = selectAfter;
      await context.editPdfObjects(page.id, edits);
    } catch (error) {
      nextSelection.current = null;
      setPreview(null);
      setLift(null);
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const transformSelection = (change: Affine) => {
    if (!view) return;
    const transform = toPdfSpace(change, view);
    void run(
      chosen.map((i) => ({ index: i.object.index, key: i.object.key, transform })),
      selected,
    );
  };
  const restack = (order: PdfObjectOrder) => {
    const indices = items.map((i) => i.object.index),
      moved = reorder(indices, new Set(selected), order);
    void run(
      chosen.map((i) => ({ index: i.object.index, key: i.object.key, order })),
      selected.map((i) => moved.indexOf(i)),
    );
  };
  const remove = () =>
    void run(
      chosen.map((i) => ({ index: i.object.index, key: i.object.key, delete: true })),
      [],
    );
  // Colours and widths change while a picker is open; commit once it settles.
  const styleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(styleTimer.current), []);
  const styled = chosen.filter((i) => i.object.kind === 'path' || i.object.kind === 'text'),
    paths = styled.filter((i) => i.object.kind === 'path');
  // Changes made while waiting merge, so width then colour is one edit with both.
  const pendingStyle = useRef<{ fill?: string; stroke?: string; strokeWidth?: number }>({});
  const restyle = (next: { fill?: string; stroke?: string; strokeWidth?: number }) => {
    clearTimeout(styleTimer.current);
    pendingStyle.current = { ...pendingStyle.current, ...next };
    styleTimer.current = setTimeout(() => {
      const change = pendingStyle.current;
      pendingStyle.current = {};
      void run(
        styled
          .map((i) => ({
            index: i.object.index,
            key: i.object.key,
            fill: change.fill,
            // Stroke only for paths: text outlines are a render-mode choice.
            ...(i.object.kind === 'path'
              ? { stroke: change.stroke, strokeWidth: change.strokeWidth }
              : {}),
          }))
          .filter((e) => e.fill || e.stroke || e.strokeWidth !== undefined),
        selected,
      );
    }, 350);
  };
  const arrange = (offsets: number[][]) => {
    if (!view) return;
    void run(
      chosen
        .map((i, n) => ({ item: i, offset: offsets[n] }))
        .filter(({ offset }) => Math.abs(offset[0]) > 1e-3 || Math.abs(offset[1]) > 1e-3)
        .map(({ item, offset }) => ({
          index: item.object.index,
          key: item.object.key,
          transform: toPdfSpace(translate(offset[0], offset[1]), view),
        })),
      selected,
    );
  };
  const align = (alignment: Alignment) =>
    arrange(
      alignOffsets(
        chosen.map((i) => i.box),
        alignment,
      ),
    );
  const distribute = (axis: 'x' | 'y') =>
    arrange(
      distributeOffsets(
        chosen.map((i) => i.box),
        axis,
      ),
    );
  const centre = () =>
    selectionBox && [
      (selectionBox[0] + selectionBox[2]) / 2,
      (selectionBox[1] + selectionBox[3]) / 2,
    ];
  const rotate = (degrees: number) => {
    const c = centre();
    if (c) transformSelection(rotateAbout((degrees * Math.PI) / 180, c[0], c[1]));
  };
  const flip = (horizontal: boolean) => {
    const c = centre();
    if (c) transformSelection(scaleAbout(horizontal ? -1 : 1, horizontal ? 1 : -1, c[0], c[1]));
  };

  // Keyboard: Delete, arrows (Shift ×10), Ctrl+A, Escape, Ctrl+[ ] (Shift: back/front).
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || editable(e.target) || document.querySelector('[aria-modal="true"]'))
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(visible.map((i) => i.object.index));
        return;
      }
      if (!selected.length || busy) return;
      if (e.key === 'Escape') setSelected([]);
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1,
          n = nudge.current;
        n.x += e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        n.y += e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        setPreview(translate(n.x, n.y));
        // Repeated nudges become one edit once the keys rest.
        clearTimeout(n.timer);
        n.timer = setTimeout(() => {
          const { x, y } = n;
          n.x = n.y = 0;
          transformSelection(translate(x, y));
        }, 450);
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.code === 'BracketRight' || e.code === 'BracketLeft')
      ) {
        e.preventDefault();
        restack(
          e.code === 'BracketRight'
            ? e.shiftKey
              ? 'front'
              : 'forward'
            : e.shiftKey
              ? 'back'
              : 'backward',
        );
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  useEffect(() => () => clearTimeout(nudge.current.timer), []);

  /** Real pixels for the drag: the chosen objects alone and the page behind
   * them. Outlines show until the bitmaps arrive; a stale answer is dropped. */
  const requestLift = (indices: number[]) => {
    if (!source || page.sourceIndex === null || !indices.length) return;
    const lifted = indices.map((i) => byIndex.get(i)).filter((i): i is Item => !!i);
    if (!lifted.length) return;
    const u = unionBox(lifted.map((i) => i.box)),
      box = [
        Math.max(0, u[0] - 2),
        Math.max(0, u[1] - 2),
        Math.min(page.width, u[2] + 2),
        Math.min(page.height, u[3] + 2),
      ],
      area = Math.max(1, (box[2] - box[0]) * (box[3] - box[1])),
      scale = Math.max(0.5, Math.min(zoom * devicePixelRatio, Math.sqrt(4_000_000 / area)));
    if (box[2] <= box[0] || box[3] <= box[1]) return;
    const chosenSet = new Set(indices),
      night = pdfNight
        ? {
            only: lifted.filter((i) => i.object.kind === 'image').map((i) => i.poly),
            except: items
              .filter((i) => i.object.kind === 'image' && !chosenSet.has(i.object.index))
              .map((i) => i.poly),
          }
        : undefined;
    const token = ++liftToken.current;
    liftPdfObjects(source, page.sourceIndex, indices, box, scale, night)
      .then((result) => {
        if (liftToken.current !== token || !gesture.current) {
          result.only.close();
          result.except.close();
          return;
        }
        setLift({ ...result, box }, false);
      })
      .catch(() => {});
  };
  const start = (e: PointerEvent, handle?: Corner | 'rotate') => {
    if (e.pointerType === 'touch' || e.button !== 0 || busy || !view || !active) return;
    e.preventDefault();
    e.stopPropagation();
    root.current!.setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    if (handle && selectionBox) {
      const c = centre()!;
      if (handle === 'rotate')
        gesture.current = {
          kind: 'rotate',
          pointer: e.pointerId,
          center: c,
          angle: Math.atan2(y - c[1], x - c[0]),
        };
      else {
        const opposite = {
          nw: [selectionBox[2], selectionBox[3]],
          ne: [selectionBox[0], selectionBox[3]],
          se: [selectionBox[0], selectionBox[1]],
          sw: [selectionBox[2], selectionBox[1]],
        }[handle];
        gesture.current = {
          kind: 'scale',
          pointer: e.pointerId,
          corner: handle,
          anchor: opposite,
          x,
          y,
        };
      }
      requestLift(selected);
      return;
    }
    const target = hit(x, y),
      add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (target && add) {
      const i = target.object.index;
      setSelected((s) => (s.includes(i) ? s.filter((v) => v !== i) : [...s, i]));
      return;
    }
    const insideSelection =
      selectionBox &&
      x >= selectionBox[0] &&
      x <= selectionBox[2] &&
      y >= selectionBox[1] &&
      y <= selectionBox[3];
    if (target && !selected.includes(target.object.index) && !insideSelection)
      setSelected([target.object.index]);
    if (target || insideSelection) {
      gesture.current = { kind: 'move', pointer: e.pointerId, x, y };
      requestLift(
        target && !selected.includes(target.object.index) && !insideSelection
          ? [target.object.index]
          : selected,
      );
      return;
    }
    if (!add) setSelected([]);
    gesture.current = { kind: 'marquee', pointer: e.pointerId, x, y, add };
    setMarquee([x, y, x, y]);
  };
  const move = (e: PointerEvent) => {
    const g = gesture.current,
      [x, y] = point(e);
    if (!g) {
      if (e.pointerType !== 'touch') {
        const target = hit(x, y)?.object.index ?? null;
        if (target !== hover) setHover(target);
      }
      return;
    }
    if (g.pointer !== e.pointerId) return;
    if (g.kind === 'move') setPreview(translate(x - g.x, y - g.y));
    else if (g.kind === 'marquee') setMarquee([g.x, g.y, x, y]);
    else if (g.kind === 'rotate') {
      let angle = Math.atan2(y - g.center[1], x - g.center[0]) - g.angle;
      if (e.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      setPreview(rotateAbout(angle, g.center[0], g.center[1]));
    } else {
      const [ax, ay] = g.anchor,
        minimum = 0.05;
      let sx = (x - ax) / (g.x - ax || 1),
        sy = (y - ay) / (g.y - ay || 1);
      if (e.shiftKey) sx = sy = Math.max(Math.abs(sx), Math.abs(sy));
      sx = Math.max(minimum, Math.abs(sx));
      sy = Math.max(minimum, Math.abs(sy));
      setPreview(scaleAbout(sx, sy, ax, ay));
    }
  };
  const end = (e: PointerEvent, cancel = false) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === 'marquee') {
      const box = marquee && [
        Math.min(marquee[0], marquee[2]),
        Math.min(marquee[1], marquee[3]),
        Math.max(marquee[0], marquee[2]),
        Math.max(marquee[1], marquee[3]),
      ];
      setMarquee(null);
      if (cancel || !box || box[2] - box[0] < 2 / zoom) return;
      // Fully enclosed objects only, so a page-sized background is not swept in.
      const inside = visible
        .filter(
          (i) =>
            i.box[0] >= box[0] && i.box[1] >= box[1] && i.box[2] <= box[2] && i.box[3] <= box[3],
        )
        .map((i) => i.object.index);
      setSelected((s) => (g.add ? [...new Set([...s, ...inside])] : inside));
      return;
    }
    const change = preview;
    if (cancel || !change || !selected.length) {
      setPreview(null);
      setLift(null);
      return;
    }
    // A click without real movement only selects.
    const moved = applyPolygon(change, [0, 0, page.width, page.height]);
    if (
      Math.max(
        Math.abs(moved[0]),
        Math.abs(moved[1]),
        Math.abs(moved[2] - page.width),
        Math.abs(moved[3] - page.height),
      ) *
        zoom <
      2
    ) {
      setPreview(null);
      return;
    }
    transformSelection(change);
  };

  if (!active || page.sourceIndex === null) return null;
  const outline = (poly: number[]) => applyPolygon(preview ?? IDENTITY, poly).join(' ');
  const s = 1 / zoom,
    previewBox = selectionBox && [
      selectionBox[0],
      selectionBox[1],
      selectionBox[2],
      selectionBox[1],
      selectionBox[2],
      selectionBox[3],
      selectionBox[0],
      selectionBox[3],
    ],
    frame = previewBox && applyPolygon(preview ?? IDENTITY, previewBox);
  const hovered = hover !== null && !selected.includes(hover) ? byIndex.get(hover) : undefined;
  const counts = new Map<Filter, number>([['all', items.length]]);
  for (const i of items) counts.set(i.object.kind, (counts.get(i.object.kind) ?? 0) + 1);
  const toolbar = (
    <div
      className="object-inspector pdf-object-inspector"
      role="toolbar"
      aria-label={t('PDF 对象编辑')}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label className="pdf-object-filter">
        <span>{t('对象类型')}</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {FILTERS.filter((f) => f === 'all' || counts.get(f)).map((f) => (
            <option key={f} value={f}>
              {t(FILTER_LABELS[f])} ({counts.get(f) ?? 0})
            </option>
          ))}
        </select>
      </label>
      <span aria-live="polite">
        {loading || busy
          ? t('正在处理 PDF 对象…')
          : status ||
            (selected.length ? t('已选择 {0} 个对象', selected.length) : t('点击或框选对象'))}
      </span>
      <button onClick={onEditText}>{t('编辑文字内容')}</button>
      {selected.length > 0 && (
        <>
          <button
            aria-label={t('逆时针旋转 90°')}
            title={t('逆时针旋转 90°')}
            disabled={busy}
            onClick={() => rotate(-90)}
          >
            <RotateCcw size={18} />
          </button>
          <button
            aria-label={t('顺时针旋转 90°')}
            title={t('顺时针旋转 90°')}
            disabled={busy}
            onClick={() => rotate(90)}
          >
            <RotateCw size={18} />
          </button>
          <button
            aria-label={t('水平翻转')}
            title={t('水平翻转')}
            disabled={busy}
            onClick={() => flip(true)}
          >
            <FlipHorizontal2 size={18} />
          </button>
          <button
            aria-label={t('垂直翻转')}
            title={t('垂直翻转')}
            disabled={busy}
            onClick={() => flip(false)}
          >
            <FlipVertical2 size={18} />
          </button>
          <button
            aria-label={t('置于顶层')}
            title={t('置于顶层 (Ctrl+Shift+])')}
            disabled={busy}
            onClick={() => restack('front')}
          >
            <BringToFront size={18} />
          </button>
          <button
            aria-label={t('上移一层')}
            title={t('上移一层 (Ctrl+])')}
            disabled={busy}
            onClick={() => restack('forward')}
          >
            <ArrowUp size={18} />
          </button>
          <button
            aria-label={t('下移一层')}
            title={t('下移一层 (Ctrl+[)')}
            disabled={busy}
            onClick={() => restack('backward')}
          >
            <ArrowDown size={18} />
          </button>
          <button
            aria-label={t('置于底层')}
            title={t('置于底层 (Ctrl+Shift+[)')}
            disabled={busy}
            onClick={() => restack('back')}
          >
            <SendToBack size={18} />
          </button>
          <button
            aria-label={t('删除所选 PDF 对象')}
            title={t('删除 (Delete)')}
            disabled={busy}
            onClick={remove}
          >
            <Trash2 size={18} />
          </button>
          {styled.length > 0 && (
            <span className="pdf-object-style" key={selected.join() + ':' + revision}>
              <label title={t('填充颜色')}>
                <span>{t('填充')}</span>
                <input
                  type="color"
                  aria-label={t('填充颜色')}
                  disabled={busy}
                  defaultValue={styled[0].object.fill ?? '#000000'}
                  onChange={(e) => restyle({ fill: e.target.value })}
                />
              </label>
              {paths.length > 0 && (
                <>
                  <label title={t('描边颜色')}>
                    <span>{t('描边')}</span>
                    <input
                      type="color"
                      aria-label={t('描边颜色')}
                      disabled={busy}
                      defaultValue={paths[0].object.stroke ?? '#000000'}
                      onChange={(e) => restyle({ stroke: e.target.value })}
                    />
                  </label>
                  <label title={t('线宽')}>
                    <span>{t('线宽')}</span>
                    <input
                      type="number"
                      aria-label={t('线宽')}
                      min={0}
                      max={1000}
                      step={0.25}
                      disabled={busy}
                      defaultValue={Math.round((paths[0].object.strokeWidth ?? 1) * 100) / 100}
                      onChange={(e) => {
                        const value = e.target.valueAsNumber;
                        if (value >= 0 && value <= 1000) restyle({ strokeWidth: value });
                      }}
                    />
                  </label>
                </>
              )}
            </span>
          )}
        </>
      )}
      {selected.length > 1 && (
        <>
          {(
            [
              ['left', '左对齐', AlignStartVertical],
              ['center', '水平居中', AlignCenterVertical],
              ['right', '右对齐', AlignEndVertical],
              ['top', '顶端对齐', AlignStartHorizontal],
              ['middle', '垂直居中', AlignCenterHorizontal],
              ['bottom', '底端对齐', AlignEndHorizontal],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              aria-label={t(label)}
              title={t(label)}
              disabled={busy}
              onClick={() => align(value)}
            >
              <Icon size={18} />
            </button>
          ))}
        </>
      )}
      {selected.length > 2 && (
        <>
          <button
            aria-label={t('水平等距分布')}
            title={t('水平等距分布')}
            disabled={busy}
            onClick={() => distribute('x')}
          >
            <AlignHorizontalDistributeCenter size={18} />
          </button>
          <button
            aria-label={t('垂直等距分布')}
            title={t('垂直等距分布')}
            disabled={busy}
            onClick={() => distribute('y')}
          >
            <AlignVerticalDistributeCenter size={18} />
          </button>
        </>
      )}
    </div>
  );
  return (
    <div
      ref={root}
      className={`pdf-object-layer${busy ? ' busy' : ''}`}
      data-objects={items.length}
      data-selected={selected.length}
      data-revision={revision}
      onPointerDown={(e) => start(e)}
      onPointerMove={move}
      onPointerUp={(e) => end(e)}
      onPointerCancel={(e) => end(e, true)}
      onLostPointerCapture={(e) => end(e, true)}
      onPointerLeave={() => setHover(null)}
    >
      {lift && (
        <>
          <LiftCanvas bitmap={lift.except} box={lift.box} />
          <LiftCanvas bitmap={lift.only} box={lift.box} transform={preview ?? IDENTITY} />
        </>
      )}
      <svg viewBox={`0 0 ${page.width} ${page.height}`} aria-hidden="true">
        {hovered && (
          <polygon
            className="pdf-object-hover"
            points={hovered.poly.join(' ')}
            strokeWidth={1.5 * s}
          />
        )}
        {chosen.map((i) => (
          <polygon
            key={i.object.index}
            className="pdf-object-selected"
            points={outline(i.poly)}
            strokeWidth={1.5 * s}
          />
        ))}
        {frame && (
          <>
            <polygon
              className="pdf-object-frame"
              points={frame.join(' ')}
              strokeWidth={1 * s}
              strokeDasharray={`${4 * s} ${3 * s}`}
            />
            {!preview && (
              <>
                <line
                  className="pdf-object-frame"
                  x1={(frame[0] + frame[2]) / 2}
                  y1={(frame[1] + frame[3]) / 2}
                  x2={(frame[0] + frame[2]) / 2}
                  y2={(frame[1] + frame[3]) / 2 - 24 * s}
                  strokeWidth={1 * s}
                />
                <circle
                  className="pdf-object-hit"
                  cx={(frame[0] + frame[2]) / 2}
                  cy={(frame[1] + frame[3]) / 2 - 24 * s}
                  r={18 * s}
                  onPointerDown={(e) => start(e, 'rotate')}
                />
                <circle
                  className="pdf-object-handle"
                  role="button"
                  aria-label={t('旋转所选对象')}
                  cx={(frame[0] + frame[2]) / 2}
                  cy={(frame[1] + frame[3]) / 2 - 24 * s}
                  r={7 * s}
                  strokeWidth={1.5 * s}
                  onPointerDown={(e) => start(e, 'rotate')}
                />
                {CORNERS.map((corner, n) => (
                  <circle
                    key={corner + '-hit'}
                    className="pdf-object-hit"
                    cx={frame[n * 2]}
                    cy={frame[n * 2 + 1]}
                    r={18 * s}
                    onPointerDown={(e) => start(e, corner)}
                  />
                ))}
                {CORNERS.map((corner, n) => (
                  <rect
                    key={corner}
                    className="pdf-object-handle"
                    role="button"
                    aria-label={t('缩放所选对象')}
                    x={frame[n * 2] - 6 * s}
                    y={frame[n * 2 + 1] - 6 * s}
                    width={12 * s}
                    height={12 * s}
                    rx={2 * s}
                    strokeWidth={1.5 * s}
                    onPointerDown={(e) => start(e, corner)}
                  />
                ))}
              </>
            )}
          </>
        )}
        {marquee && (
          <rect
            className="pdf-object-marquee"
            x={Math.min(marquee[0], marquee[2])}
            y={Math.min(marquee[1], marquee[3])}
            width={Math.abs(marquee[2] - marquee[0])}
            height={Math.abs(marquee[3] - marquee[1])}
            strokeWidth={1 * s}
          />
        )}
      </svg>
      {host && createPortal(toolbar, host)}
    </div>
  );
}
