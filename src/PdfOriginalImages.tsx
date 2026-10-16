import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { trackPerformance } from './performanceLedger';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from './pdfTypes';
import { X, ScanText, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Page } from './model';
import { getPdfImages } from './pdfNight';
import { polygonBox, transformPolygon, type ImagePolygon } from './pdfNightGeometry';
import { requestPdfTile, renderingCancelled } from './pdfRenderCache';
import { t as tr, useLocale } from './i18n';
import ZoomableImagePreview from './ZoomableImagePreview';
import ImageDownloadButton from './ImageDownloadButton';
import ImageCopyButton from './ImageCopyButton';
import { DocumentEditContext } from './DocumentEditContext';
import { adjacentOriginalImage, type OriginalImageSelection } from './originalImageGallery';
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
    [selected, setSelected] = useState<OriginalImageSelection | null>(null),
    [status, setStatus] = useState(''),
    [imageAspect, setImageAspect] = useState<number | null>(null),
    [readyKey, setReadyKey] = useState('');
  const [showOcr, setShowOcr] = useState(false),
    [navigating, setNavigating] = useState(false),
    [boundary, setBoundary] = useState({ previous: false, next: false });
  const editing = useContext(DocumentEditContext);
  const navigationJob = useRef<AbortController | null>(null);
  const openImage = (polygon: number[], imageIndex: number) => {
    if (sourceIndex !== null) setSelected({ pageId, sourceIndex, imageIndex, polygon });
  };
  const anchor = useRef<HTMLSpanElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const galleryPages = () => editing?.notebook.pages ?? [{ id: pageId, sourceIndex, bitmapOcr }];
  const selectedPage = selected ? galleryPages().find((p) => p.id === selected.pageId) : undefined;
  const ocr = selected
    ? selectedPage?.bitmapOcr?.find((b) => b.imageIndex === selected.imageIndex)?.result
    : undefined;
  const pictureBox = selected ? polygonBox(selected.polygon) : null;
  const selectionKey = selected ? `${selected.pageId}:${selected.imageIndex}` : '';
  const imageReady = imageAspect !== null && readyKey === selectionKey;
  const navigateImage = async (direction: -1 | 1) => {
    if (
      !selected ||
      !pdf ||
      navigationJob.current ||
      (direction < 0 ? boundary.previous : boundary.next)
    )
      return;
    const owner = new AbortController();
    navigationJob.current = owner;
    setNavigating(true);
    try {
      const next = await adjacentOriginalImage(
        pdf,
        galleryPages(),
        selected,
        direction,
        owner.signal,
      );
      if (owner.signal.aborted) return;
      if (next) setSelected(next);
      else setBoundary((b) => ({ ...b, [direction < 0 ? 'previous' : 'next']: true }));
    } catch {
      if (!owner.signal.aborted) setStatus(tr('图片切换失败，请重试。'));
    } finally {
      if (navigationJob.current === owner) {
        navigationJob.current = null;
        if (!owner.signal.aborted) setNavigating(false);
      }
    }
  };
  const navigateRef = useRef(navigateImage);
  navigateRef.current = navigateImage;
  useEffect(() => {
    setNavigating(false);
    setBoundary({ previous: false, next: false });
    return () => {
      navigationJob.current?.abort();
      navigationJob.current = null;
    };
  }, [selected, pdf]);
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
              openImage(polygon, i);
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
    // A cold metadata index may finish after a fast mouse double-click. Resolve
    // that gesture asynchronously instead of requiring a mounted hit overlay.
    const paper = anchor.current?.parentElement;
    if (!enabled || !paper || !pdf || sourceIndex === null) return;
    let dead = false;
    const doubleClick = (event: MouseEvent) => {
      if (event.button !== 0 || (event.target as Element).closest('button,a')) return;
      const bounds = paper.getBoundingClientRect();
      const rx = (event.clientX - bounds.left) / bounds.width,
        ry = (event.clientY - bounds.top) / bounds.height;
      if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return;
      void Promise.all([pdf.getPage(sourceIndex + 1), getPdfImages(pdf, sourceIndex)])
        .then(([page, polygons]) => {
          if (dead) return;
          const vp = page.getViewport({ scale: 1 }),
            x = rx * vp.width,
            y = ry * vp.height;
          for (let i = polygons.length - 1; i >= 0; i--) {
            const polygon = transformPolygon(polygons[i], vp.transform);
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
            if (inside) {
              openImage(polygon, i);
              break;
            }
          }
        })
        .catch(() => {});
    };
    const clickRoot = paper.closest('.surface,.reading-view') ?? paper;
    clickRoot.addEventListener('dblclick', doubleClick as EventListener, true);
    return () => {
      dead = true;
      clickRoot.removeEventListener('dblclick', doubleClick as EventListener, true);
    };
  }, [enabled, pdf, sourceIndex]);
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
        openImage(images[tap.image], tap.image);
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
    const output = canvas.current!;
    setShowOcr(false);
    let dead = false;
    let cancel: (() => void) | undefined;
    const abort = new AbortController();
    setImageAspect(null);
    setStatus(tr('加载原图…'));
    void trackPerformance('pdf-display', async () => {
      const page = await pdf.getPage(selected.sourceIndex + 1);
      if (dead) return;
      const { drawPdfOriginalImage } = await import('./pdfOriginalImage');
      let extracted = false;
      try {
        extracted = await drawPdfOriginalImage(
          pdf,
          selected.sourceIndex,
          selected.imageIndex,
          output,
          abort.signal,
        );
      } catch {
        // Unsupported image objects retain the high-resolution region fallback.
      }
      if (dead) return;
      if (extracted) {
        setImageAspect(output.width / output.height);
        setReadyKey(selectionKey);
        setStatus('');
        return;
      }
      const viewport = page.getViewport({ scale: 1 }),
        box = polygonBox(selected.polygon),
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
        c = output;
      c.width = w;
      c.height = h;
      for (let top = 0; top < h; top += 1024)
        for (let left = 0; left < w; left += 1024) {
          if (dead) return;
          const lease = requestPdfTile(
            pdf,
            selected.sourceIndex,
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
      setReadyKey(selectionKey);
      setStatus(tr('显示高清页面区域'));
    }).catch((e) => {
      if (!dead && !renderingCancelled(e)) setStatus(tr('原图加载失败'));
    });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSelected(null);
      } else if (
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        if (
          e.target instanceof Element &&
          e.target.closest('input,textarea,select,[contenteditable=true]')
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        void navigateRef.current(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', key, true);
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
                  openImage(polygon, i);
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
                  <span className="original-image-position">
                    {tr(
                      '第 {0} 页 · 图片 {1}',
                      galleryPages().findIndex((p) => p.id === selected.pageId) + 1,
                      selected.imageIndex + 1,
                    )}
                  </span>
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
                <div className="original-image-heading">
                  <ImageCopyButton
                    key={`copy:${selectionKey}`}
                    source={() => canvas.current}
                    disabled={!imageReady}
                    onStatus={setStatus}
                  />
                  <ImageDownloadButton
                    key={`download:${selectionKey}`}
                    compact
                    source={() => canvas.current}
                    name={`TixTab-page-${selected.sourceIndex + 1}-image-${selected.imageIndex + 1}.png`}
                    disabled={!imageReady}
                    onError={setStatus}
                  />
                  <button
                    className="icon-button"
                    aria-label={tr('关闭原图')}
                    onClick={() => setSelected(null)}
                  >
                    <X size={18} />
                  </button>
                </div>
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
              <div className="original-image-stage" aria-busy={navigating}>
                <ZoomableImagePreview
                  key={selectionKey}
                  canvasRef={canvas}
                  aspectRatio={
                    imageReady ? imageAspect! : pictureBox!.width / Math.max(1, pictureBox!.height)
                  }
                />
                <button
                  className="original-image-step previous"
                  aria-label={tr('上一张图片')}
                  title={tr('上一张图片')}
                  disabled={navigating || boundary.previous}
                  onClick={() => void navigateImage(-1)}
                >
                  <ChevronLeft size={26} />
                </button>
                <button
                  className="original-image-step next"
                  aria-label={tr('下一张图片')}
                  title={tr('下一张图片')}
                  disabled={navigating || boundary.next}
                  onClick={() => void navigateImage(1)}
                >
                  <ChevronRight size={26} />
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
