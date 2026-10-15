import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { paintLiveInk, releaseLiveInk } from './liveInk';
import type { ScratchInkRouting } from './ScratchInkContext';
/** One viewport-sized preview above both sheets. Samples retain their original
 * paper units; only this transient display projects them into screen units. */
export default forwardRef<Pick<ScratchInkRouting, 'preview'>>(function ScratchLiveInk(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null),
    owner = useRef('');
  useImperativeHandle(
    ref,
    () => ({
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
  useEffect(
    () => () => {
      if (canvas.current) releaseLiveInk(canvas.current);
    },
    [],
  );
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
