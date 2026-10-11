import { useAppearance } from './appearance';
import { t as tr, useLocale } from './i18n';
import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Page } from './model';
import { requestPdfBitmap, renderingCancelled } from './pdfRenderCache';
import { finalInkPath } from './ink';
export default memo(function PageThumbnail({
  page,
  pdf,
}: {
  page: Page;
  pdf: PDFDocumentProxy | null;
}) {
  useLocale();
  const { pdfNight } = useAppearance();
  const root = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: root.current?.closest('.page-list'),
      rootMargin: '150px',
    });
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const c = canvas.current!;
    let dead = false,
      cancel: (() => void) | undefined;
    if (!visible || !pdf || page.sourceIndex === null) {
      c.width = 1;
      c.height = 1;
      return;
    }
    const lease = requestPdfBitmap(
      pdf,
      page.sourceIndex,
      Math.min(180 / page.width, 240 / page.height),
      2,
      pdfNight,
    );
    cancel = lease.cancel;
    void lease.promise
      .then((bitmap) => {
        if (!dead) {
          c.width = bitmap.width;
          c.height = bitmap.height;
          c.getContext('2d')!.drawImage(bitmap, 0, 0);
          c.dataset.renderedNight = String(pdfNight);
        }
      })
      .catch(() => {});
    return () => {
      dead = true;
      cancel?.();
    };
  }, [pdf, page.id, visible, pdfNight]);
  return (
    <div
      className={`page-mini page-thumbnail ${page.sourceIndex === null ? `thumbnail-${page.paper}` : ''}`}
      data-pdf-night={pdfNight}
      ref={root}
      style={{ aspectRatio: `${page.width}/${page.height}` }}
    >
      <canvas ref={canvas} />
      {visible && (
        <svg viewBox={`0 0 ${page.width} ${page.height}`} aria-hidden="true">
          {page.images.map((i) => (
            <image
              key={i.id}
              href={i.displayData ?? i.data}
              x={i.x}
              y={i.y}
              width={i.width}
              height={i.height}
            />
          ))}
          {page.strokes.map((s) => (
            <path
              key={s.id}
              d={finalInkPath(s)}
              fill={s.color}
              opacity={s.tool === 'highlighter' ? 0.28 : s.tool === 'pencil' ? 0.65 : 1}
            />
          ))}
        </svg>
      )}
    </div>
  );
});
