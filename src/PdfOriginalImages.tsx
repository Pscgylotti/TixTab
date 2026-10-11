import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Image, X } from 'lucide-react';
import { useAppearance } from './appearance';
import { getPdfImages } from './pdfNight';
import { polygonBox, transformPolygon, type ImagePolygon } from './pdfNightGeometry';
import { requestPdfBitmap, renderingCancelled } from './pdfRenderCache';
import { t as tr, useLocale } from './i18n';
export default function PdfOriginalImages({
  pdf,
  sourceIndex,
  enabled,
}: {
  pdf: PDFDocumentProxy | null;
  sourceIndex: number | null;
  enabled: boolean;
}) {
  useLocale();
  const { pdfNight } = useAppearance();
  const [images, setImages] = useState<ImagePolygon[]>([]),
    [selected, setSelected] = useState<number[] | null>(null),
    [status, setStatus] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    setImages([]);
    setSelected(null);
    if (pdfNight && pdf && sourceIndex !== null)
      void pdf
        .getPage(sourceIndex + 1)
        .then(async (page) => {
          const polygons = await getPdfImages(pdf, sourceIndex);
          if (!dead)
            setImages(
              polygons.map((p) => transformPolygon(p, page.getViewport({ scale: 1 }).transform)),
            );
        })
        .catch(() => {});
    return () => {
      dead = true;
    };
  }, [pdf, sourceIndex, pdfNight]);
  useEffect(() => {
    if (!selected || !pdf || sourceIndex === null) return;
    let dead = false;
    let cancel: (() => void) | undefined;
    setStatus(tr('加载原图…'));
    void (async () => {
      const page = await pdf.getPage(sourceIndex + 1);
      if (dead) return;
      const viewport = page.getViewport({ scale: 1 }),
        scale = Math.min(2, Math.sqrt(3_000_000 / (viewport.width * viewport.height))),
        lease = requestPdfBitmap(pdf, sourceIndex, scale, 0, false);
      cancel = lease.cancel;
      const bitmap = await lease.promise;
      if (dead) return;
      const box = polygonBox(selected),
        x = Math.max(0, Math.floor(box.x * scale)),
        y = Math.max(0, Math.floor(box.y * scale)),
        w = Math.max(1, Math.min(bitmap.width - x, Math.ceil(box.width * scale))),
        h = Math.max(1, Math.min(bitmap.height - y, Math.ceil(box.height * scale))),
        c = canvas.current!;
      c.width = w;
      c.height = h;
      c.getContext('2d')!.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
      setStatus('');
    })().catch((e) => {
      if (!dead && !renderingCancelled(e)) setStatus(tr('原图加载失败'));
    });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSelected(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      dead = true;
      cancel?.();
      window.removeEventListener('keydown', key, true);
    };
  }, [selected, pdf, sourceIndex]);
  return (
    <>
      {pdfNight &&
        enabled &&
        images.slice(0, 128).map((polygon, i) => {
          const b = polygonBox(polygon);
          return (
            b.width >= 24 &&
            b.height >= 24 && (
              <button
                className="pdf-original-image"
                key={i}
                style={{ left: Math.max(0, b.x), top: Math.max(0, b.y) }}
                title={tr('查看原图')}
                aria-label={tr('查看原图 {0}', i + 1)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(polygon);
                }}
              >
                <Image size={13} />
              </button>
            )
          );
        })}
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
                <h2>{tr('原图')}</h2>
                <button
                  className="icon-button"
                  aria-label={tr('关闭原图')}
                  onClick={() => setSelected(null)}
                >
                  <X size={18} />
                </button>
              </header>
              {status && <p role="status">{status}</p>}
              <div className="original-image-content">
                <canvas width={1} height={1} ref={canvas} />
              </div>
              <p className="muted">{tr('按原 PDF 区域显示，保留其上的叠加内容。')}</p>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
