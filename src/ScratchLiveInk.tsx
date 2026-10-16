import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { paintLiveInk, releaseLiveInk } from './liveInk';
import type { ScratchInkRouting } from './ScratchInkContext';
import type { ErasePreview } from './scratchErase';
import { drawStroke } from './ink';
interface LiveInkHandle extends Pick<ScratchInkRouting, 'preview'> {
  previewErase: (owner: string, parts: ErasePreview[]) => void;
}
/** One viewport-sized preview above both sheets. Samples retain their original
 * paper units; only this transient display projects them into screen units. */
export default forwardRef<LiveInkHandle>(function ScratchLiveInk(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null),
    owner = useRef('');
  useImperativeHandle(
    ref,
    () => ({
      previewErase(id, parts) {
        const c = canvas.current;
        if (!c || (!parts.length && owner.current !== id)) return;
        if (!parts.length) {
          releaseLiveInk(c);
          owner.current = '';
          return;
        }
        owner.current = id;
        const view = c.parentElement!.getBoundingClientRect();
        if (!(view.width > 0 && view.height > 0)) return;
        const ratio = Math.min(
          Math.max(1, window.devicePixelRatio),
          8192 / view.width,
          8192 / view.height,
          Math.sqrt(16_000_000 / (view.width * view.height)),
        );
        const width = Math.max(1, Math.floor(view.width * ratio)),
          height = Math.max(1, Math.floor(view.height * ratio));
        if (c.width !== width || c.height !== height) {
          c.width = width;
          c.height = height;
        }
        c.style.left = c.style.top = '0px';
        c.style.width = `${view.width}px`;
        c.style.height = `${view.height}px`;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(width / view.width, 0, 0, height / view.height, 0, 0);
        ctx.clearRect(0, 0, view.width, view.height);
        for (const part of parts) {
          ctx.save();
          const { rect: r, page } = part;
          ctx.beginPath();
          ctx.rect(r.left - view.left, r.top - view.top, r.width, r.height);
          ctx.clip();
          // Subtract each foreground sheet separately so overlapping occluders
          // cannot expose background ink through an even-odd overlap.
          for (const cover of part.occluders) {
            ctx.beginPath();
            ctx.rect(0, 0, view.width, view.height);
            ctx.rect(cover.left - view.left, cover.top - view.top, cover.width, cover.height);
            ctx.clip('evenodd');
          }
          const sx = r.width / page.width,
            sy = r.height / page.height;
          ctx.translate(r.left - view.left, r.top - view.top);
          ctx.scale(sx, sy);
          for (const s of part.strokes) drawStroke(ctx, s);
          ctx.strokeStyle = '#e05b62';
          ctx.lineWidth = 2 / sx;
          for (const image of part.images)
            ctx.strokeRect(image.x, image.y, image.width, image.height);
          ctx.restore();
        }
        c.dataset.previewOwner = id;
      },
      preview(page, stroke, paper) {
        const c = canvas.current;
        if (!c) return;
        if (!stroke) {
          if (owner.current === page.id) {
            releaseLiveInk(c);
            owner.current = '';
          }
          return;
        }
        const view = c.parentElement!.getBoundingClientRect(),
          sx = paper.width / page.width,
          sy = paper.height / page.height;
        owner.current = page.id;
        const displayed = {
          ...stroke,
          size: stroke.size * sx,
          points: stroke.points.map(
            ([x, y, p]) =>
              [paper.left - view.left + x * sx, paper.top - view.top + y * sy, p] as [
                number,
                number,
                number,
              ],
          ),
        };
        paintLiveInk(
          c,
          { width: view.width, height: view.height },
          [displayed],
          view,
          view,
          window.devicePixelRatio,
        );
        c.dataset.previewOwner = page.id;
        c.dataset.previewSamples = String(stroke.points.length);
      },
    }),
    [],
  );
  useEffect(() => {
    // React clears refs before passive unmount cleanup. Retain the node here
    // so leaving scratch mode also releases an unfinished gesture's texture.
    const node = canvas.current;
    return () => {
      if (node) releaseLiveInk(node);
    };
  }, []);
  return (
    <canvas
      ref={canvas}
      className="scratch-cross-ink live-layer"
      width={1}
      height={1}
      aria-hidden="true"
    />
  );
});
