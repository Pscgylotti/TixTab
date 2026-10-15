import { t as tr, useLocale } from './i18n';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { ForegroundClip } from './foregroundViewport';
import { isEraser, isPicture, type Page, type PlacedImage } from './model';
import { objectBox, objectsInBox, transformObjects, type ObjectBox } from './objectSelection';
import { groupDisplay } from './objectGroup';
import { useAppearance } from './appearance';
import type { SpatialIndex } from './spatialIndex';
type Corner = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';
interface Props {
  page: Page;
  index: SpatialIndex<PlacedImage>;
  active: boolean;
  zoom: number;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onChange: (page: Page) => void;
  clip?: ForegroundClip;
  pinned?: string[];
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
export default function ObjectLayer({
  page,
  index,
  active,
  zoom,
  selected,
  onSelect,
  onChange,
  clip,
  pinned,
}: Props) {
  useLocale();
  const { night, pdfNight } = useAppearance();
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
  const start = (e: PointerEvent, image?: PlacedImage, handle?: Corner, selectionBody = false) => {
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
      marquee: !image && !handle && !selectionBody,
      prior: e.shiftKey ? selected : [],
      initial: selected,
    };
    if (!image && !handle && !selectionBody) {
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
    else if (g.handle.length === 1) {
      const west = g.handle === 'w',
        north = g.handle === 'n';
      const horizontal = west || g.handle === 'e';
      const width = horizontal
        ? Math.max(
            Math.min(16, o.width),
            Math.min(west ? o.x + o.width : page.width - o.x, o.width + (west ? -dx : dx)),
          )
        : o.width;
      const height = horizontal
        ? o.height
        : Math.max(
            Math.min(16, o.height),
            Math.min(north ? o.y + o.height : page.height - o.y, o.height + (north ? -dy : dy)),
          );
      g.latest = {
        x: west ? o.x + o.width - width : o.x,
        y: north ? o.y + o.height - height : o.y,
        width,
        height,
      };
    } else {
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
      onSelect([...new Set([...g.prior, ...objectsInBox(g.original, g.latest, index)])]);
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
        cancel
          ? g.initial
          : [...new Set([...g.prior, ...objectsInBox(g.original, g.latest, index)])],
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
  const order = useMemo(() => new Map(page.images.map((i, n) => [i.id, n])), [page.images]);
  const visible = useMemo(() => {
    if (clip === undefined) return images;
    index.update(page.images);
    const ids = new Set([
      ...(clip === false ? [] : index.search(clip).map((i) => i.id)),
      ...selected,
      ...(pinned ?? []),
      ...(gesture.current?.ids ?? []),
    ]);
    return images.filter((i) => ids.has(i.id));
  }, [images, page.images, clip, selected, pinned, index]);
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
        data-total-objects={images.length}
        data-visible-objects={visible.length}
        onPointerDown={(e) => start(e)}
        {...handlers}
      >
        {visible.map((i) => (
          <div
            key={i.id}
            className={`placed-object ${selected.includes(i.id) ? 'chosen' : ''}${i.scratchPage ? ' scratch-pdf-page' : ''}`}
            data-object-id={i.id}
            aria-label={
              i.group
                ? tr('组合对象')
                : i.kind === 'text'
                  ? tr('文本框对象')
                  : isPicture(i)
                    ? tr('图片对象')
                    : i.kind === 'sketch'
                      ? tr('草图对象')
                      : tr('公式对象')
            }
            style={{
              left: i.x,
              top: i.y,
              width: i.width,
              height: i.height,
              zIndex: order.get(i.id)! * 2 + 2,
            }}
            onPointerDown={(e) => start(e, i)}
          >
            <img
              src={groupDisplay(i, night, pdfNight)}
              style={
                i.group || (pdfNight && i.scratchPage)
                  ? { filter: i.group || i.nightData ? 'none' : 'invert(0.9) hue-rotate(180deg)' }
                  : undefined
              }
              data-night-ink={!isPicture(i)}
              alt={
                i.kind === 'text'
                  ? i.textBox?.content
                  : isPicture(i)
                    ? tr('图片')
                    : i.kind === 'formula'
                      ? i.latex
                      : tr('Excalidraw 草图')
              }
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
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            const p = point(e);
            index.update(page.images);
            const hit = index.search({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }).at(-1);
            start(e, hit, undefined, !hit);
          }}
          {...handlers}
          style={
            {
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              pointerEvents: selected.length > 1 ? 'auto' : 'none',
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
          {selected.length === 1 &&
            images.some((i) => i.id === selected[0] && isPicture(i) && !i.group) &&
            (['n', 's', 'w', 'e'] as const).map((edge, n) => (
              <button
                key={edge}
                className={`object-handle ${edge}`}
                aria-label={tr('拉伸图片{0}', tr(['上边', '下边', '左边', '右边'][n]))}
                onPointerDown={(e) => start(e, undefined, edge)}
                {...handlers}
              />
            ))}
        </div>
      )}
    </>
  );
}
