import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { trackPerformance } from './performanceLedger';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { X, ScanText } from 'lucide-react';
import type { Page } from './model';
import { getPdfImages } from './pdfNight';
import { polygonBox, transformPolygon, type ImagePolygon } from './pdfNightGeometry';
import { requestPdfTile, renderingCancelled } from './pdfRenderCache';
import { t as tr, useLocale } from './i18n';
import ZoomableImagePreview from './ZoomableImagePreview';
import { refreshPenHover, registerPenTargets, usePenInteraction } from './penInteraction';
export default function PdfOriginalImages({
  pdf,
  sourceIndex,
  enabled,
  pageId,
  bitmapOcr,
}: {
  pdf: PDFDocumentProxy | null;
  sourceIndex: number | null;
  enabled: boolean;
  pageId: string;
  bitmapOcr?: Page['bitmapOcr'];
}) {
  useLocale();
  const penActive = usePenInteraction(pageId),
    loadImages = enabled || penActive;
  const [images, setImages] = useState<ImagePolygon[]>([]),
    [selected, setSelected] = useState<number[] | null>(null),
    [status, setStatus] = useState(''),
    [imageAspect, setImageAspect] = useState<number | null>(null);
  const [showOcr, setShowOcr] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    selectedImageIndex = useRef(-1);
  const ocr = selected
    ? bitmapOcr?.find((b) => b.imageIndex === selectedImageIndex.current)?.result
    : undefined;
  const pictureBox = selected ? polygonBox(selected) : null;
  useLayoutEffect(() => {
    refreshPenHover();
  }, [penActive, images]);
  useEffect(() => {
    if (!pdf || sourceIndex === null) return;
    return registerPenTargets(pageId, {
      kind: 'image',
      hit: async (clientX, clientY) => {
        const page = await pdf.getPage(sourceIndex + 1);
        const polygons = await getPdfImages(pdf, sourceIndex);
        const viewport = page.getViewport({ scale: 1 });
        const bounds = anchor.current?.parentElement?.getBoundingClientRect();
        if (!bounds?.width || !bounds.height) return null;
        const x = ((clientX - bounds.left) / bounds.width) * viewport.width;
        const y = ((clientY - bounds.top) / bounds.height) * viewport.height;
        for (let i = polygons.length - 1; i >= 0; i--) {
          const polygon = transformPolygon(polygons[i], viewport.transform);
          let inside = false;
          for (let a = 0, b = polygon.length - 2; a < polygon.length; b = a, a += 2)
            if (
              polygon[a + 1] > y !== polygon[b + 1] > y &&
              x <
                ((polygon[b] - polygon[a]) * (y - polygon[a + 1])) /
                  (polygon[b + 1] - polygon[a + 1]) +
                  polygon[a]
            )
              inside = !inside;
          if (inside)
            return () => {
              selectedImageIndex.current = i;
              setSelected(polygon);
            };
        }
        return null;
      },
    });
  }, [pdf, sourceIndex, pageId]);
  useEffect(() => {
    setImages([]);
    setSelected(null);
  }, [pdf, sourceIndex]);
  useEffect(() => {
    let dead = false;
    if (loadImages && pdf && sourceIndex !== null)
      void trackPerformance('pdf-images', () =>
        pdf.getPage(sourceIndex + 1).then(async (page) => {
          const polygons = await getPdfImages(pdf, sourceIndex);
          if (!dead)
            setImages(
              polygons.map((p) => transformPolygon(p, page.getViewport({ scale: 1 }).transform)),
            );
        }),
      ).catch(() => {});
    return () => {
      dead = true;
    };
  }, [pdf, sourceIndex, loadImages]);
  useEffect(() => {
    const paper = anchor.current?.parentElement,
      root = paper?.closest('.surface,.reading-view');
    if (!enabled || !paper || !root || !images.length) return;
    type Tap = { x: number; y: number; time: number; image: number; moved: boolean };
    const active = new Map<number, Tap>();
    let previous: Tap | undefined;
    const hit = (event: PointerEvent) => {
      const box = paper.getBoundingClientRect(),
        x = ((event.clientX - box.left) * paper.offsetWidth) / box.width,
        y = ((event.clientY - box.top) * paper.offsetHeight) / box.height;
      for (let i = images.length - 1; i >= 0; i--) {
        const p = images[i];
        let inside = false;
        for (let a = 0, b = p.length - 2; a < p.length; b = a, a += 2)
          if (
            p[a + 1] > y !== p[b + 1] > y &&
            x < ((p[b] - p[a]) * (y - p[a + 1])) / (p[b + 1] - p[a + 1]) + p[a]
          )
            inside = !inside;
        if (inside) return i;
      }
      return -1;
    };
    const down = (event: Event) => {
      const e = event as PointerEvent;
      if (e.button !== 0 || (e.target as Element).closest('button,a')) return;
      active.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        time: e.timeStamp,
        image: hit(e),
        moved: false,
      });
      if (active.size > 1) {
        previous = undefined;
        active.forEach((tap) => {
          tap.moved = true;
        });
      }
    };
    const move = (event: Event) => {
      const e = event as PointerEvent,
        tap = active.get(e.pointerId);
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) {
        tap.moved = true;
        previous = undefined;
      }
    };
    const up = (event: Event) => {
      const e = event as PointerEvent,
        tap = active.get(e.pointerId);
      active.delete(e.pointerId);
      if (
        !tap ||
        tap.moved ||
        tap.image < 0 ||
        e.timeStamp - tap.time > 450 ||
        hit(e) !== tap.image
      ) {
        previous = undefined;
        return;
      }
      if (
        previous &&
        previous.image === tap.image &&
        e.timeStamp - previous.time < 450 &&
        Math.hypot(tap.x - previous.x, tap.y - previous.y) < 24
      ) {
        selectedImageIndex.current = tap.image;
        setSelected(images[tap.image]);
        previous = undefined;
      } else previous = { ...tap, time: e.timeStamp };
    };
    const cancel = (event: Event) => {
      active.delete((event as PointerEvent).pointerId);
      previous = undefined;
    };
    const listeners = {
      pointerdown: down,
      pointermove: move,
      pointerup: up,
      pointercancel: cancel,
    };
    for (const [name, fn] of Object.entries(listeners)) root.addEventListener(name, fn, true);
    return () => {
      for (const [name, fn] of Object.entries(listeners)) root.removeEventListener(name, fn, true);
    };
  }, [enabled, images]);
  useEffect(() => {
    if (!selected || !pdf || sourceIndex === null) return;
    setShowOcr(false);
    let dead = false;
    let cancel: (() => void) | undefined;
    const abort = new AbortController();
    setImageAspect(null);
    setStatus(tr('加载原图…'));
    void trackPerformance('pdf-display', async () => {
      const page = await pdf.getPage(sourceIndex + 1);
      if (dead) return;
      const { drawPdfOriginalImage } = await import('./pdfOriginalImage');
      let extracted = false;
      try {
        extracted = await drawPdfOriginalImage(
          pdf,
          sourceIndex,
          selectedImageIndex.current,
          canvas.current!,
          abort.signal,
        );
      } catch {
        // Unsupported image objects retain the high-resolution region fallback.
      }
      if (dead) return;
      if (extracted) {
        setImageAspect(canvas.current!.width / canvas.current!.height);
        setStatus('');
        return;
      }
      const viewport = page.getViewport({ scale: 1 }),
        box = polygonBox(selected),
        scale = Math.min(
          8,
          Math.max(4, devicePixelRatio * 2),
          Math.sqrt(16_000_000 / Math.max(1, box.width * box.height)),
        ),
        x = Math.max(0, Math.floor(box.x * scale)),
        y = Math.max(0, Math.floor(box.y * scale)),
        w = Math.max(
          1,
          Math.min(Math.floor(viewport.width * scale) - x, Math.ceil(box.width * scale)),
        ),
        h = Math.max(
          1,
          Math.min(Math.floor(viewport.height * scale) - y, Math.ceil(box.height * scale)),
        ),
        c = canvas.current!;
      c.width = w;
      c.height = h;
      for (let top = 0; top < h; top += 1024)
        for (let left = 0; left < w; left += 1024) {
          if (dead) return;
          const lease = requestPdfTile(
            pdf,
            sourceIndex,
            scale,
            {
              x: x + left,
              y: y + top,
              width: Math.min(1024, w - left),
              height: Math.min(1024, h - top),
            },
            0,
            false,
          );
          cancel = lease.cancel;
          const tile = await lease.promise;
          if (dead) return;
          c.getContext('2d')!.drawImage(tile, left, top);
        }
      setImageAspect(w / h);
      setStatus(tr('显示高清页面区域'));
    }).catch((e) => {
      if (!dead && !renderingCancelled(e)) setStatus(tr('原图加载失败'));
    });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSelected(null);
      }
    };
    window.addEventListener('keydown', key, true);
    const output = canvas.current;
    return () => {
      dead = true;
      abort.abort();
      cancel?.();
      if (output) output.width = output.height = 1;
      window.removeEventListener('keydown', key, true);
    };
  }, [selected, pdf, sourceIndex]);
  return (
    <>
      <span ref={anchor} hidden />
      {penActive && (
        <div className="pdf-image-interactions">
          {images.map((polygon, i) => {
            const b = polygonBox(polygon);
            if (b.width <= 0 || b.height <= 0) return null;
            const points = polygon.map(
              (value, n) => ((value - (n % 2 ? b.y : b.x)) / (n % 2 ? b.height : b.width)) * 100,
            );
            return (
              <button
                key={i}
                data-pen-interactive="image"
                aria-label={tr('查看原图 {0}', i + 1)}
                style={{
                  left: b.x,
                  top: b.y,
                  width: b.width,
                  height: b.height,
                  clipPath: `polygon(${points.reduce<string[]>((list, _, n) => (n % 2 ? list : [...list, `${points[n]}% ${points[n + 1]}%`]), []).join(',')})`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  selectedImageIndex.current = i;
                  setSelected(polygon);
                }}
              >
                <svg
                  viewBox={`0 0 ${b.width} ${b.height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polygon
                    points={polygon
                      .reduce<string[]>(
                        (list, _, n) =>
                          n % 2 ? list : [...list, `${polygon[n] - b.x},${polygon[n + 1] - b.y}`],
                        [],
                      )
                      .join(' ')}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </button>
            );
          })}
        </div>
      )}
      {selected &&
        createPortal(
          <div
            className="modal-scrim original-image-scrim"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-label={tr('原图')}
              className="modal original-image-modal"
            >
              <header>
                <div className="original-image-heading">
                  <h2>{tr('原图')}</h2>
                  <button
                    className="icon-button"
                    aria-label={tr('查看 OCR 信息')}
                    title={tr('查看 OCR 信息')}
                    aria-expanded={showOcr}
                    onClick={() => setShowOcr((value) => !value)}
                  >
                    <ScanText size={17} />
                  </button>
                </div>
                <button
                  className="icon-button"
                  aria-label={tr('关闭原图')}
                  onClick={() => setSelected(null)}
                >
                  <X size={18} />
                </button>
              </header>
              {status && <p role="status">{status}</p>}
              {showOcr && (
                <section className="original-image-ocr" aria-label={tr('OCR 解析内容')}>
                  {ocr ? (
                    <>
                      <p className="muted">{ocr.engine}</p>
                      <pre>{ocr.text || tr('已解析，未识别到文字')}</pre>
                    </>
                  ) : (
                    <p className="muted">{tr('此图片尚未解析，请先使用“解析位图”。')}</p>
                  )}
                </section>
              )}
              <ZoomableImagePreview
                key={selected.join(',')}
                canvasRef={canvas}
                aspectRatio={imageAspect ?? pictureBox!.width / Math.max(1, pictureBox!.height)}
              />
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
