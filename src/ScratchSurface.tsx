import { getTouchMode } from './inputPreferences';
import { isTouchReplay } from './touchMode';
import { paperAppearance } from './paperAppearance';
import { useAppearance } from './appearance';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import PageEditor from './PageEditor';
import { PanZoomPointers } from './gestures';
import type { ScratchPaper } from './scratchPaper';
import type { Page, Tool } from './model';
import type { PenDiagnostic } from './PdfSurface';
import './scratch.css';
export default function ScratchSurface({
  paper,
  tool,
  color,
  size,
  active,
  focusObjectId,
  onActivate,
  onChange,
  onView,
  onEditObject,
  onDiagnostic,
}: {
  paper: ScratchPaper;
  tool: Tool;
  color: string;
  size: number;
  active: boolean;
  focusObjectId: string | string[] | null;
  onActivate: () => void;
  onChange: (p: Page) => void;
  onView: (view: ScratchPaper['view']) => void;
  onEditObject: (p: Page, id: string) => void;
  onDiagnostic: (d: PenDiagnostic) => void;
}) {
  const { pdfNight } = useAppearance();
  const root = useRef<HTMLDivElement>(null),
    [view, setView] = useState(paper.view);
  const state = useRef(view);
  state.current = view;
  const pointers = useRef(new PanZoomPointers()),
    frame = useRef(0),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useRef(onView);
  save.current = onView;
  const penTime = useRef(-Infinity);
  const transform = (next: ScratchPaper['view']) => {
    state.current = next;
    setView(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save.current(state.current), 300);
  };
  useLayoutEffect(() => {
    state.current = paper.view;
    setView(paper.view);
  }, [paper.id]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(saveTimer.current);
      save.current(state.current);
    },
    [],
  );
  const zoomAt = (factor: number, x: number, y: number) => {
    const r = root.current!.getBoundingClientRect(),
      v = state.current;
    const z = Math.max(0.08, Math.min(8, v.zoom * factor));
    const dx = x - r.left - r.width / 2,
      dy = y - r.top - r.height / 2;
    transform({ x: v.x + dx / v.zoom - dx / z, y: v.y + dy / v.zoom - dy / z, zoom: z });
  };
  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const d = pointers.current.take();
    if (!d) return;
    if (d.scale !== 1) zoomAt(d.scale, d.x, d.y);
    const v = state.current;
    transform({ ...v, x: v.x - d.dx / v.zoom, y: v.y - d.dy / v.zoom });
  };
  useEffect(() => {
    const el = root.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.008), e.clientX, e.clientY);
      else {
        const v = state.current;
        transform({ ...v, x: v.x + e.deltaX / v.zoom, y: v.y + e.deltaY / v.zoom });
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const cancel = () => {
      pointers.current.reset();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  const down = (e: ReactPointerEvent) => {
    if (e.pointerType === 'pen') penTime.current = performance.now();
    if (e.pointerType === 'touch' && !getTouchMode() && performance.now() - penTime.current < 650)
      return;
    if (!(e.pointerType === 'touch' || (tool === 'hand' && e.button === 0) || e.button === 1))
      return;
    e.preventDefault();
    if (!isTouchReplay(e.nativeEvent)) e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.down(e.pointerId, e.clientX, e.clientY);
  };
  const end = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    flush();
    pointers.current.up(e.pointerId);
    save.current(state.current);
  };
  return (
    <div
      className={`scratch-viewport tool-${tool}`}
      ref={root}
      data-scratch-zoom={view.zoom}
      data-scratch-x={view.x}
      data-scratch-y={view.y}
      onPointerDownCapture={onActivate}
      onPointerDown={down}
      onPointerMove={(e) => {
        if (pointers.current.has(e.pointerId)) {
          pointers.current.move(e.pointerId, e.clientX, e.clientY);
          frame.current ||= requestAnimationFrame(flush);
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      <div
        className="scratch-paper paper"
        data-pdf-night={pdfNight}
        data-page-id={paper.page.id}
        data-scratch-id={paper.id}
        style={{
          width: paper.page.width,
          height: paper.page.height,
          ...paperAppearance(paper.page, pdfNight),
          transform: `translate(${-view.x * view.zoom}px,${-view.y * view.zoom}px) scale(${view.zoom})`,
        }}
      >
        <PageEditor
          page={paper.page}
          pdf={null}
          tool={tool}
          color={color}
          size={size}
          zoom={view.zoom}
          onChange={onChange}
          onDiagnostic={onDiagnostic}
          onContext={() => {}}
          onEditObject={(id) => onEditObject(paper.page, id)}
          focusObjectId={focusObjectId}
          viewport={root}
          active={active}
          onActivate={onActivate}
          reading
          forceClip
          viewKey={`${view.x}:${view.y}:${view.zoom}`}
        />
      </div>
    </div>
  );
}
