import { useAppearance, renderPolicy, renderDensity } from './appearance';
import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import type { PDFDocumentProxy } from './pdfTypes';
import { requestPdfTile, renderingCancelled, type PdfPixelRegion } from './pdfRenderCache';
import { usePdfBitmapDisplay } from './usePdfBitmapDisplay';
import { planPdfTiles, type TilePlan } from './pdfTiles';
import {
  performanceDelay,
  performanceLedger,
  trackPerformance,
  type PerformanceFinish,
} from './performanceLedger';

const DetailTile = memo(function DetailTile({
  pdf,
  sourceIndex,
  scale,
  tile,
  priority,
}: {
  pdf: PDFDocumentProxy;
  sourceIndex: number;
  scale: number;
  tile: PdfPixelRegion;
  priority: number;
}) {
  const { pdfNight } = useAppearance();
  const { host, display, recovery } = usePdfBitmapDisplay();
  const [ready, setReady] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    let dead = false;
    setReady(false);
    setError(false);
    const lease = requestPdfTile(pdf, sourceIndex, scale, tile, priority, pdfNight);
    void trackPerformance('pdf-display', () =>
      lease.promise.then((bitmap) => {
        if (dead) return;
        display.current!.show(bitmap, pdfNight);
        setReady(true);
      }),
    ).catch((e) => {
      if (!dead && !renderingCancelled(e)) setError(true);
    });
    return () => {
      dead = true;
      lease.cancel();
    };
  }, [
    pdf,
    sourceIndex,
    scale,
    tile.x,
    tile.y,
    tile.width,
    tile.height,
    priority,
    pdfNight,
    recovery,
  ]);
  return (
    <div
      className="pdf-detail-tile"
      data-ready={ready}
      data-error={error}
      data-x={tile.x}
      data-y={tile.y}
      data-scale={scale}
      style={{
        position: 'absolute',
        left: tile.x / scale,
        top: tile.y / scale,
        width: tile.width / scale,
        height: tile.height / scale,
        visibility: ready ? 'visible' : 'hidden',
      }}
    >
      <div ref={host} style={{ display: 'contents' }} />
    </div>
  );
});

interface Props {
  pdf: PDFDocumentProxy | null;
  sourceIndex: number | null;
  width: number;
  height: number;
  zoom: number;
  baseScale: number;

  viewport: RefObject<HTMLElement | null>;
  viewKey?: string | number;
  priority?: number;
}
export default memo(function PdfDetailLayer(props: Props) {
  const { mode, quality, battery, pdfNight, memoryMode } = useAppearance();
  const layer = useRef<HTMLDivElement>(null),
    latest = useRef(props);
  latest.current = props;
  const trigger = useRef<() => void>(() => {});
  const [plan, setPlan] = useState<
    (TilePlan & { pdf: PDFDocumentProxy; sourceIndex: number }) | null
  >(null);
  useEffect(() => {
    const viewport = props.viewport.current!;
    let frame = 0,
      timer: (() => void) | undefined,
      finish: PerformanceFinish | undefined;
    const measure = () => {
      const p = latest.current,
        el = layer.current;
      if (!el || !p.pdf || p.sourceIndex === null) {
        setPlan(null);
        return;
      }
      const paper = el.getBoundingClientRect(),
        view = viewport.getBoundingClientRect();
      if (!paper.width || !paper.height) {
        setPlan(null);
        return;
      }
      const scaleX = paper.width / p.width,
        scaleY = paper.height / p.height;
      const left = Math.max(paper.left, view.left),
        top = Math.max(paper.top, view.top),
        right = Math.min(paper.right, view.right),
        bottom = Math.min(paper.bottom, view.bottom);
      if (right <= left || bottom <= top) {
        setPlan(null);
        return;
      }
      const target =
        p.zoom *
        Math.min(
          renderDensity(window.devicePixelRatio),
          Math.sqrt(renderPolicy().viewPixels / Math.max(1, (right - left) * (bottom - top))),
        );
      const next = planPdfTiles(
        p.width,
        p.height,
        {
          x: (left - paper.left) / scaleX,
          y: (top - paper.top) / scaleY,
          width: (right - left) / scaleX,
          height: (bottom - top) / scaleY,
        },
        target,
        renderPolicy().detailPixels,
      );
      if (next.scale < p.baseScale * 1.15) {
        setPlan(null);
        return;
      }
      setPlan((old) =>
        old?.pdf === p.pdf &&
        old.sourceIndex === p.sourceIndex &&
        old.scale === next.scale &&
        old.tiles.length === next.tiles.length &&
        old.tiles.every(
          (tile, i) =>
            tile.x === next.tiles[i].x &&
            tile.y === next.tiles[i].y &&
            tile.width === next.tiles[i].width &&
            tile.height === next.tiles[i].height,
        )
          ? old
          : { ...next, pdf: p.pdf!, sourceIndex: p.sourceIndex! },
      );
    };
    const changed = () => {
      timer?.();
      if (!frame) {
        finish = performanceLedger?.begin('pdf-detail-plan');
        frame = requestAnimationFrame(() => {
          frame = 0;
          timer = performanceDelay('pdf-detail-plan', measure, renderPolicy().detailMs);
          finish?.();
          finish = undefined;
        });
      }
    };
    trigger.current = changed;
    const observer = new ResizeObserver(changed);
    observer.observe(viewport);
    observer.observe(layer.current!);
    viewport.addEventListener('scroll', changed, { passive: true });
    window.addEventListener('resize', changed);
    changed();
    return () => {
      trigger.current = () => {};
      cancelAnimationFrame(frame);
      timer?.();
      finish?.('cancelled');
      observer.disconnect();
      viewport.removeEventListener('scroll', changed);
      window.removeEventListener('resize', changed);
    };
  }, [props.viewport]);
  useEffect(() => {
    trigger.current();
  }, [
    props.pdf,
    props.sourceIndex,
    props.width,
    props.height,
    props.zoom,
    props.baseScale,

    props.viewKey,
    mode,
    quality,
    battery,
    pdfNight,
    memoryMode,
  ]);
  const active = plan?.pdf === props.pdf && plan.sourceIndex === props.sourceIndex ? plan : null;
  return (
    <div
      className="pdf-detail-layer"
      ref={layer}
      data-pdf-night={pdfNight}
      aria-hidden="true"
      data-pixels={active?.pixels ?? 0}
      data-scale={active?.scale ?? 0}
    >
      {active?.tiles.map((tile) => (
        <DetailTile
          key={`${active.scale}:${tile.x}:${tile.y}`}
          pdf={active.pdf}
          sourceIndex={active.sourceIndex}
          scale={active.scale}
          tile={tile}
          priority={props.priority ?? 1}
        />
      ))}
    </div>
  );
});
