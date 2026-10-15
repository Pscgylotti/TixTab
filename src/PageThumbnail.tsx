import { useAppearance, renderPolicy } from './appearance';
import { trackPerformance } from './performanceLedger';
import { t as tr, useLocale } from './i18n';
import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from './pdfTypes';
import { isPicture, type Page } from './model';
import { requestPdfThumbnail } from './pdfRenderCache';
import { usePdfBitmapDisplay } from './usePdfBitmapDisplay';
import { finalInkPath } from './ink';
import { pageLayers } from './pageLayers';
import { groupDisplay } from './objectGroup';
import { paperAppearance } from './paperAppearance';
export default memo(function PageThumbnail({
  page,
  pdf,
}: {
  page: Page;
  pdf: PDFDocumentProxy | null;
}) {
  useLocale();
  const { night, pdfNight, memoryMode } = useAppearance();
  const root = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState(false);
  const { host, display, recovery } = usePdfBitmapDisplay();
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: root.current?.closest('.page-list'),
      rootMargin: renderPolicy().minimal ? '0px' : '150px',
    });
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, [memoryMode]);
  useEffect(() => {
    let dead = false,
      cancel: (() => void) | undefined;
    if (!visible || !pdf || page.sourceIndex === null) {
      display.current!.clear();
      return;
    }
    const lease = requestPdfThumbnail(pdf, page.sourceIndex, page.width, page.height, pdfNight);
    cancel = lease.cancel;
    void trackPerformance('pdf-display', () =>
      lease.promise.then((bitmap) => {
        if (!dead) {
          display.current!.show(bitmap, pdfNight);
        }
      }),
    ).catch(() => {});
    return () => {
      dead = true;
      cancel?.();
    };
  }, [pdf, page.id, page.sourceIndex, page.width, page.height, visible, pdfNight, recovery]);
  return (
    <div
      className={`page-mini page-thumbnail ${page.sourceIndex === null ? `thumbnail-${page.paper}` : ''}`}
      data-pdf-night={pdfNight}
      data-pdf-source={page.sourceIndex ?? ''}
      data-blank-paper={page.sourceIndex === null ? true : undefined}
      ref={root}
      style={{
        aspectRatio: `${page.width}/${page.height}`,
        ...(page.sourceIndex === null ? paperAppearance(page, pdfNight) : {}),
      }}
    >
      <div ref={host} style={{ display: 'contents' }} />
      {visible && (
        <svg viewBox={`0 0 ${page.width} ${page.height}`} aria-hidden="true">
          {pageLayers(page).map((i) =>
            i ? (
              <image
                key={`object:${i.id}`}
                data-night-ink={!isPicture(i)}
                href={groupDisplay(i, night, pdfNight)}
                style={
                  i.group || (pdfNight && i.scratchPage)
                    ? { filter: i.group || i.nightData ? 'none' : 'invert(0.9) hue-rotate(180deg)' }
                    : undefined
                }
                x={i.x}
                y={i.y}
                width={i.width}
                height={i.height}
              />
            ) : (
              <g key="ink" className="thumbnail-ink">
                {page.strokes.map((s) => (
                  <path
                    key={s.id}
                    d={finalInkPath(s)}
                    fill={s.color}
                    opacity={s.tool === 'highlighter' ? 0.28 : s.tool === 'pencil' ? 0.65 : 1}
                  />
                ))}
              </g>
            ),
          )}
        </svg>
      )}
    </div>
  );
});
