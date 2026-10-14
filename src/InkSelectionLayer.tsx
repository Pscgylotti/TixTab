import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Copy, Scissors, ClipboardPaste, Trash2, X } from 'lucide-react';
import type { Page, Tool } from './model';
import { cullingInkBounds, finalInkPath } from './ink';
import { SpatialIndex, type Bounds } from './spatialIndex';
import {
  copyInk,
  drawingTool,
  inkBox,
  pasteInkFromButton,
  registerInkGesture,
  selectInk,
  selectedInk,
  strokeInBox,
  subscribeInk,
  translateInk,
} from './inkSelection';
import { t as tr } from './i18n';

export default function InkSelectionLayer({
  page,
  tool,
  zoom,
  root,
  viewport,
  onChange,
  onActivate,
}: {
  page: Page;
  tool: Tool;
  zoom: number;
  root: RefObject<HTMLElement | null>;
  viewport: RefObject<HTMLElement | null>;
  onChange: (page: Page) => void;
  onActivate?: () => void;
}) {
  const ids = useSyncExternalStore(subscribeInk, () => selectedInk(page.id));
  const current = useRef({ page, onChange, onActivate });
  current.current = { page, onChange, onActivate };
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  const [delta, setDelta] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const tree = useRef(new SpatialIndex<Page['strokes'][number]>(cullingInkBounds));
  const start = useRef<{ x: number; y: number } | null>(null);
  const busy = useRef(false),
    frame = useRef(0),
    pending = useRef<{ x: number; y: number } | null>(null);
  const alive = useRef(true),
    moveFrame = useRef(0);
  const moving = useRef<{ id: number; x: number; y: number; dx: number; dy: number } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelAnimationFrame(moveFrame.current);
    };
  }, []);
  const point = (x: number, y: number) => {
    const bounds = root.current!.getBoundingClientRect();
    return {
      x: ((x - bounds.left) / bounds.width) * current.current.page.width,
      y: ((y - bounds.top) / bounds.height) * current.current.page.height,
    };
  };
  useEffect(() => {
    const update = (x: number, y: number, select: boolean) => {
      if (!start.current || !root.current) return;
      const p = point(x, y),
        a = start.current;
      const box = {
        minX: Math.min(a.x, p.x),
        minY: Math.min(a.y, p.y),
        maxX: Math.max(a.x, p.x),
        maxY: Math.max(a.y, p.y),
      };
      if (select) {
        selectInk(
          page.id,
          tree.current
            .search(box)
            .filter((s) => strokeInBox(s, box))
            .map((s) => s.id),
        );
        setMarquee(null);
        start.current = null;
      } else setMarquee(box);
    };
    const remove = registerInkGesture(page.id, (phase, x, y) => {
      if (!root.current) return;
      if (phase === 'start') {
        current.current.onActivate?.();
        selectInk(page.id, []);
        setError('');
        tree.current.update(current.current.page.strokes);
        start.current = point(x, y);
      } else if (phase === 'move') {
        pending.current = { x, y };
        if (!frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (pending.current) update(pending.current.x, pending.current.y, false);
          });
      } else {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        pending.current = null;
        if (phase === 'end') update(x, y, true);
        else {
          start.current = null;
          setMarquee(null);
        }
      }
    });
    let mouse: number | null = null;
    const down = (e: PointerEvent) => {
      if (!drawingTool(tool)) return;
      const element = e.target instanceof Element ? e.target : null;
      if (!element || !root.current?.contains(element)) {
        if (!element?.closest('.ink-selection-controls')) selectInk(page.id, []);
        return;
      }
      if (e.pointerType === 'mouse' && e.altKey && e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        mouse = e.pointerId;
        current.current.onActivate?.();
        selectInk(page.id, []);
        tree.current.update(current.current.page.strokes);
        start.current = point(e.clientX, e.clientY);
      } else if (!element.closest('.ink-selection-box') && !(e.buttons & 2)) selectInk(page.id, []);
    };
    const move = (e: PointerEvent) => {
      if (mouse !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      pending.current = { x: e.clientX, y: e.clientY };
      if (!frame.current)
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          if (pending.current) update(pending.current.x, pending.current.y, false);
        });
    };
    const up = (e: PointerEvent) => {
      if (mouse !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      mouse = null;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      pending.current = null;
      if (e.type === 'pointercancel') {
        start.current = null;
        setMarquee(null);
      } else update(e.clientX, e.clientY, true);
    };
    const cancel = () => {
      moving.current = null;
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
      mouse = null;
      start.current = pending.current = null;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      setMarquee(null);
      setDelta({ x: 0, y: 0 });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (start.current || moving.current)) {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    return () => {
      moving.current = null;
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
      remove();
      cancelAnimationFrame(frame.current);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      if (selectedInk(page.id).length) selectInk(page.id, []);
    };
  }, [page.id, tool]);
  const chosen = useMemo(() => {
    const set = new Set(ids);
    return page.strokes.filter((s) => set.has(s.id));
  }, [page.strokes, ids]);
  const box = useMemo(() => inkBox(chosen), [chosen]);
  const paths = useMemo(() => chosen.map((s) => <path key={s.id} d={finalInkPath(s)} />), [chosen]);
  const copy = async (cut: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setError('');
    const original = current.current.page,
      selected = [...ids];
    try {
      await copyInk(original, selected);
      if (
        alive.current &&
        cut &&
        current.current.page.id === original.id &&
        selected.every(
          (id) =>
            current.current.page.strokes.find((s) => s.id === id) ===
            original.strokes.find((s) => s.id === id),
        )
      ) {
        const set = new Set(selected),
          p = current.current.page;
        current.current.onChange({ ...p, strokes: p.strokes.filter((s) => !set.has(s.id)) });
        selectInk(page.id, []);
      }
    } catch {
      if (alive.current) setError(tr('复制失败，所选对象已保留。'));
    } finally {
      busy.current = false;
    }
  };
  const removeInk = () => {
    const set = new Set(ids);
    onChange({ ...page, strokes: page.strokes.filter((s) => !set.has(s.id)) });
    selectInk(page.id, []);
  };
  useEffect(() => {
    if (!ids.length) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        (e.target as Element)?.closest('input,textarea,select,[contenteditable="true"]') ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      if (e.key === 'Escape') {
        e.preventDefault();
        selectInk(page.id, []);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        removeInk();
      } else if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        ['c', 'x'].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
        e.stopPropagation();
        void copy(e.key.toLowerCase() === 'x');
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [ids, page]);
  const endMove = (e: ReactPointerEvent, cancel = false) => {
    const m = moving.current;
    if (!m || m.id !== e.pointerId) return;
    e.stopPropagation();
    moving.current = null;
    cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    if (!cancel && (m.dx || m.dy)) {
      const set = new Set(ids),
        moved = new Map(translateInk(chosen, m.dx, m.dy).map((s) => [s.id, s]));
      onChange({
        ...page,
        strokes: page.strokes.map((s) => (set.has(s.id) ? moved.get(s.id)! : s)),
      });
    }
    setDelta({ x: 0, y: 0 });
  };
  const rectStyle = (b: Bounds) => ({
    left: b.minX,
    top: b.minY,
    width: Math.max(1, b.maxX - b.minX),
    height: Math.max(1, b.maxY - b.minY),
    borderWidth: 1 / zoom,
  });
  return (
    <>
      {marquee && (
        <div className="object-marquee ink-marquee" data-ink-marquee style={rectStyle(marquee)} />
      )}
      {box && (
        <>
          <svg className="ink-selection-highlight" viewBox={`0 0 ${page.width} ${page.height}`}>
            <g transform={`translate(${delta.x} ${delta.y})`}>{paths}</g>
          </svg>
          <div
            className="ink-selection-box object-selection"
            aria-label={tr('笔迹选择')}
            data-selected-strokes={chosen.length}
            style={{ ...rectStyle(box), transform: `translate(${delta.x}px,${delta.y}px)` }}
            onPointerDown={(e) => {
              if (e.button !== 0 || e.pointerType === 'touch') return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = point(e.clientX, e.clientY);
              moving.current = { id: e.pointerId, x: p.x, y: p.y, dx: 0, dy: 0 };
            }}
            onPointerMove={(e) => {
              const m = moving.current;
              if (!m || m.id !== e.pointerId) return;
              e.preventDefault();
              e.stopPropagation();
              const p = point(e.clientX, e.clientY);
              m.dx = Math.max(-box.minX, Math.min(page.width - box.maxX, p.x - m.x));
              m.dy = Math.max(-box.minY, Math.min(page.height - box.maxY, p.y - m.y));
              if (!moveFrame.current)
                moveFrame.current = requestAnimationFrame(() => {
                  moveFrame.current = 0;
                  const latest = moving.current;
                  if (latest) setDelta({ x: latest.dx, y: latest.dy });
                });
            }}
            onPointerUp={(e) => endMove(e)}
            onPointerCancel={(e) => endMove(e, true)}
            onLostPointerCapture={(e) => endMove(e, true)}
          />
          {viewport.current?.parentElement &&
            createPortal(
              <div
                className="ink-selection-controls object-context-toolbar"
                role="toolbar"
                aria-label={tr('笔迹选择')}
              >
                <button
                  className="icon-button"
                  title={tr('复制')}
                  aria-label={tr('复制')}
                  onClick={() => void copy(false)}
                >
                  <Copy size={17} />
                </button>
                <button
                  className="icon-button"
                  title={tr('剪切')}
                  aria-label={tr('剪切')}
                  onClick={() => void copy(true)}
                >
                  <Scissors size={17} />
                </button>
                <button
                  className="icon-button"
                  title={tr('粘贴')}
                  aria-label={tr('粘贴')}
                  onClick={() =>
                    void pasteInkFromButton().catch(() =>
                      setError(tr('剪贴板中没有可粘贴的 TixTab 对象')),
                    )
                  }
                >
                  <ClipboardPaste size={17} />
                </button>
                <button
                  className="icon-button"
                  title={tr('删除')}
                  aria-label={tr('删除')}
                  onClick={removeInk}
                >
                  <Trash2 size={17} />
                </button>
                <button
                  className="icon-button"
                  title={tr('关闭')}
                  aria-label={tr('关闭')}
                  onClick={() => selectInk(page.id, [])}
                >
                  <X size={17} />
                </button>
                {error && <span role="status">{error}</span>}
              </div>,
              viewport.current.parentElement,
            )}
        </>
      )}
    </>
  );
}
