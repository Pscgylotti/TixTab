import { useEffect, useRef, useState, type RefObject } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { PanZoomPointers } from './gestures';
import { t } from './i18n';

type View = { scale: number; x: number; y: number };
const initial: View = { scale: 1, x: 0, y: 0 };

/** Transform the existing crop; zooming never starts another PDF render. */
export default function ZoomableImagePreview({
  canvasRef,
  aspectRatio,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  aspectRatio: number;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    pointers = useRef(new PanZoomPointers()),
    current = useRef(initial),
    frame = useRef(0);
  const [view, setView] = useState(initial);

  function update(next: View) {
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return;
    const scale = Math.max(1, Math.min(8, next.scale)),
      width = Math.min(box.width, box.height * aspectRatio),
      height = Math.min(box.height, box.width / aspectRatio),
      maxX = Math.max(0, (width * scale - box.width) / 2),
      maxY = Math.max(0, (height * scale - box.height) / 2);
    current.current = {
      scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setView(current.current);
      });
  }

  function zoom(factor: number, clientX?: number, clientY?: number, dx = 0, dy = 0) {
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return;
    const before = current.current,
      scale = Math.max(1, Math.min(8, before.scale * factor)),
      ratio = scale / before.scale,
      x = clientX === undefined ? 0 : clientX - box.left - box.width / 2,
      y = clientY === undefined ? 0 : clientY - box.top - box.height / 2;
    update({
      scale,
      x: x - (x - before.x) * ratio + dx,
      y: y - (y - before.y) * ratio + dy,
    });
  }

  useEffect(() => {
    const element = viewport.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      zoom(
        Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003),
        event.clientX,
        event.clientY,
      );
    };
    const resize = new ResizeObserver(() => update(current.current));
    resize.observe(element);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      resize.disconnect();
      element.removeEventListener('wheel', wheel);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      pointers.current.reset();
    };
  }, [aspectRatio]);

  return (
    <>
      <div
        ref={viewport}
        className="original-image-content"
        tabIndex={0}
        aria-label={t('原图缩放预览')}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.down(event.pointerId, event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          event.stopPropagation();
          pointers.current.move(event.pointerId, event.clientX, event.clientY);
          const delta = pointers.current.take();
          if (delta) zoom(delta.scale, delta.x, delta.y, delta.dx, delta.dy);
        }}
        onPointerUp={(event) => pointers.current.up(event.pointerId)}
        onPointerCancel={(event) => pointers.current.up(event.pointerId)}
        onLostPointerCapture={(event) => pointers.current.up(event.pointerId)}
        onDoubleClick={() => update(initial)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === '+' || event.key === '=') zoom(1.25);
          else if (event.key === '-') zoom(0.8);
          else if (event.key === 'Home' || event.key === '0') update(initial);
          else return;
          event.preventDefault();
        }}
      >
        <div
          className="original-image-transform"
          style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})` }}
        >
          <canvas width={1} height={1} ref={canvasRef} />
        </div>
      </div>
      <div className="original-image-zoom" role="group" aria-label={t('原图缩放')}>
        <button
          className="icon-button"
          aria-label={t('缩小原图')}
          disabled={view.scale <= 1}
          onClick={() => zoom(0.8)}
        >
          <Minus size={18} />
        </button>
        <output>{Math.round(view.scale * 100)}%</output>
        <button
          className="icon-button"
          aria-label={t('放大原图')}
          disabled={view.scale >= 8}
          onClick={() => zoom(1.25)}
        >
          <Plus size={18} />
        </button>
        <button
          className="icon-button"
          aria-label={t('重置原图缩放')}
          onClick={() => update(initial)}
        >
          <RotateCcw size={18} />
        </button>
      </div>
    </>
  );
}
