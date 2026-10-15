import { useEffect } from 'react';
import type { PDFDocumentProxy } from './pdfTypes';
import type { Page } from './model';
import { useAppearance, renderPolicy, pageRenderScale } from './appearance';
import { hasPdfBitmap, requestPdfBitmap, requestPdfHalf } from './pdfRenderCache';
import { prefetchTargets } from './pdfPrefetch';
import { performanceDelay, trackPerformance } from './performanceLedger';
export default function PdfPrefetch({
  pdf,
  pages,
  index,
  mode,
  zoom,
}: {
  pdf: PDFDocumentProxy | null;
  pages: Page[];
  index: number;
  mode: 'single' | 'continuous' | 'dual';
  zoom: number;
}) {
  const appearance = useAppearance(),
    policy = renderPolicy(),
    targets = prefetchTargets(pages, index, mode, appearance.preRender),
    signature = targets
      .map(
        ({ page, side }) =>
          `${page.id}:${page.sourceIndex}:${page.width}:${page.height}:${side ?? 'full'}`,
      )
      .join('|');
  useEffect(() => {
    if (!pdf || !targets.length) return;
    let cancelled = false,
      release: (() => void) | undefined;
    const cancelTimer = performanceDelay(
      'pdf-prefetch',
      () => {
        void trackPerformance('pdf-prefetch', async () => {
          for (const { page, side } of targets) {
            if (cancelled) return;
            const scale = pageRenderScale(
              zoom,
              devicePixelRatio,
              page.width,
              page.height,
              mode !== 'single',
              policy,
            );
            if (hasPdfBitmap(pdf, page.sourceIndex!, scale, appearance.pdfNight)) continue;
            const lease = side
              ? requestPdfHalf(
                  pdf,
                  page.sourceIndex!,
                  scale,
                  page.width,
                  page.height,
                  side,
                  appearance.pdfNight,
                )
              : requestPdfBitmap(pdf, page.sourceIndex!, scale, 3, appearance.pdfNight);
            release = lease.cancel;
            await lease.promise;
          }
        }).catch(() => {});
      },
      Math.max(500, policy.settleMs * 2),
    );
    return () => {
      cancelled = true;
      cancelTimer();
      release?.();
    };
  }, [
    pdf,
    signature,
    zoom,
    mode,
    appearance.preRender,
    appearance.pdfNight,
    appearance.mode,
    appearance.quality,
    appearance.battery,
  ]);
  return null;
}
