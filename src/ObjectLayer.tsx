import { t as tr, useLocale } from './i18n';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { isEraser, type Page, type PlacedImage } from './model';
import { objectBox, objectsInBox, transformObjects, type ObjectBox } from './objectSelection';
type Corner = 'nw' | 'ne' | 'sw' | 'se';
interface Props {
  page: Page;
  active: boolean;
  zoom: number;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onChange: (page: Page) => void;
}
interface Gesture {
  pointer: number;
  original: PlacedImage[];
  ids: string[];
  start: { x: number; y: number };
  from: ObjectBox;
  latest: ObjectBox;
  handle?: Corner;
  marquee: boolean;
  prior: string[];
  initial: string[];
}
export default function ObjectLayer({ page, active, zoom, selected, onSelect, onChange }: Props) {
  useLocale();
  const root = useRef<HTMLDivElement>(null),
    [preview, setPreview] = useState<PlacedImage[] | null>(null),
    [marquee, setMarquee] = useState<ObjectBox | null>(null);
  const frame = useRef(0),
    gesture = useRef<Gesture | null>(null);
  useEffect(() => {
    gesture.current = null;
    setPreview(null);
    setMarquee(null);
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, [page.id, page.images, active]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const point = (e: PointerEvent) => {
    const r = root.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(page.width, ((e.clientX - r.left) / r.width) * page.width)),
      y: Math.max(0, Math.min(page.height, ((e.clientY - r.top) / r.height) * page.height)),
    };
  };
  const start = (e: PointerEvent, image?: PlacedImage, handle?: Corner) => {
    if (!active || isEraser(e) || e.button !== 0 || e.pointerType === 'touch' || gesture.current)
      return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    let ids = selected;
    if (image) {
      if (e.shiftKey) {
        onSelect(
          selected.includes(image.id)
            ? selected.filter((id) => id !== image.id)
            : [...selected, image.id],
        );
        return;
      }
      ids = selected.includes(image.id) ? selected : [image.id];
      onSelect(ids);
    }
    const from = objectBox(page.images, ids),
      p = point(e);
    gesture.current = {
      pointer: e.pointerId,
      original: page.images,
      ids,
      start: p,
      from: from ?? { ...p, width: 0, height: 0 },
      latest: from ?? { ...p, width: 0, height: 0 },
      handle,
      marquee: !image && !handle,
      prior: e.shiftKey ? selected : [],
      initial: selected,
    };
    if (!image && !handle) {
      if (!e.shiftKey) onSelect([]);
      setMarquee({ ...p, width: 0, height: 0 });
    }
  };
  const update = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const p = point(e),
      dx = p.x - g.start.x,
      dy = p.y - g.start.y,
      o = g.from;
    if (g.marquee)
      g.latest = {
        x: Math.min(g.start.x, p.x),
        y: Math.min(g.start.y, p.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      };
    else if (!g.handle)
      g.latest = {
        ...o,
        x: Math.max(0, Math.min(page.width - o.width, o.x + dx)),
        y: Math.max(0, Math.min(page.height - o.height, o.y + dy)),
      };
    else {
      const sx = g.handle.endsWith('w') ? -1 : 1,
        sy = g.handle.startsWith('n') ? -1 : 1,
        ax = o.x + (sx < 0 ? o.width : 0),
        ay = o.y + (sy < 0 ? o.height : 0);
      const desired =
        ((o.width + sx * dx) * o.width + (o.height + sy * dy) * o.height) /
        (o.width ** 2 + o.height ** 2);
      const max = Math.min(
          (sx < 0 ? ax : page.width - ax) / o.width,
          (sy < 0 ? ay : page.height - ay) / o.height,
        ),
        scale = Math.min(max, Math.max(Math.min(16 / o.width, 16 / o.height), desired));
      g.latest = {
        x: ax - (sx < 0 ? o.width * scale : 0),
        y: ay - (sy < 0 ? o.height * scale : 0),
        width: o.width * scale,
        height: o.height * scale,
      };
    }
  };
  const show = () => {
    frame.current = 0;
    const g = gesture.current;
    if (!g) return;
    if (g.marquee) {
      setMarquee(g.latest);
      onSelect([...new Set([...g.prior, ...objectsInBox(g.original, g.latest)])]);
    } else setPreview(transformObjects(g.original, g.ids, g.from, g.latest));
  };
  const move = (e: PointerEvent) => {
    if (gesture.current?.pointer !== e.pointerId) return;
    e.stopPropagation();
    update(e);
    if (!frame.current) frame.current = requestAnimationFrame(show);
  };
  const end = (e: PointerEvent, cancel = false) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    e.stopPropagation();
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (!cancel) update(e);
    gesture.current = null;
    setPreview(null);
    setMarquee(null);
    if (g.marquee)
      onSelect(
        cancel ? g.initial : [...new Set([...g.prior, ...objectsInBox(g.original, g.latest)])],
      );
    else if (
      !cancel &&
      ['x', 'y', 'width', 'height'].some(
        (k) => g.from[k as keyof ObjectBox] !== g.latest[k as keyof ObjectBox],
      )
    )
      onChange({ ...page, images: transformObjects(g.original, g.ids, g.from, g.latest) });
  };
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && active) {
        gesture.current = null;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        setPreview(null);
        setMarquee(null);
        onSelect([]);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [active, onSelect]);
  const images = preview ?? page.images,
    box = objectBox(images, selected);
  const handlers = {
    onPointerMove: move,
    onPointerUp: (e: PointerEvent) => end(e),
    onPointerCancel: (e: PointerEvent) => end(e, true),
    onLostPointerCapture: (e: PointerEvent) => end(e, true),
  };
  return (
    <>
      <div
        className={`object-layer ${active ? 'active' : ''}`}
        ref={root}
        onPointerDown={(e) => start(e)}
        {...handlers}
      >
        {images.map((i) => (
          <div
            key={i.id}
            className={`placed-object ${selected.includes(i.id) ? 'chosen' : ''}`}
            data-object-id={i.id}
            aria-label={i.kind === 'sketch' ? tr('草图对象') : tr('公式对象')}
            style={{ left: i.x, top: i.y, width: i.width, height: i.height }}
            onPointerDown={(e) => start(e, i)}
          >
            <img
              src={i.displayData ?? i.data}
              alt={i.kind === 'formula' ? i.latex : tr('Excalidraw 草图')}
              draggable={false}
            />
          </div>
        ))}
        {marquee && (
          <div
            className="object-marquee"
            style={{
              left: marquee.x,
              top: marquee.y,
              width: marquee.width,
              height: marquee.height,
              borderWidth: 1.5 / zoom,
            }}
          />
        )}
      </div>
      {active && box && !marquee && (
        <div
          className="object-selection"
          data-selected-count={selected.length}
          style={
            {
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              '--handle-size': `${22 / zoom}px`,
              '--outline-size': `${1.5 / zoom}px`,
            } as React.CSSProperties
          }
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner, n) => (
            <button
              key={corner}
              className={`object-handle ${corner}`}
              aria-label={tr('缩放对象{0}', tr(['左上角', '右上角', '左下角', '右下角'][n]))}
              onPointerDown={(e) => start(e, undefined, corner)}
              {...handlers}
            />
          ))}
        </div>
      )}
    </>
  );
}
