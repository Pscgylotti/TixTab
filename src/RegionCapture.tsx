import { t as tr, useLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { PageRegion } from './capturePage';
import { clippedCaptureBox } from './captureGeometry';
export default function RegionCapture({
  onCapture,
  onClose,
  onBitmapOcr,
  hint = '拖动框选截图区域',
  label = '框选识别区域',
  targetPageId,
}: {
  onCapture: (pageId: string | null, region: PageRegion) => void;
  onClose: () => void;
  onBitmapOcr?: () => void;
  hint?: string;
  label?: string;
  targetPageId?: string;
}) {
  useLocale();
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [onClose]);
  const contact = useRef<{
    id: number;
    x: number;
    y: number;
    rect: DOMRect;
    width: number;
    height: number;
    pageId: string | null;
  } | null>(null);
  const [box, setBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  return (
    <div
      className="region-capture"
      role="dialog"
      aria-label={tr(label)}
      aria-modal="true"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.capture-hint') || contact.current || e.button !== 0)
          return;
        const area = e.currentTarget.getBoundingClientRect();
        let paper: HTMLElement | undefined,
          distance = Infinity;
        for (const candidate of document.querySelectorAll<HTMLElement>('.paper,.reading-paper')) {
          if (
            targetPageId &&
            candidate.closest<HTMLElement>('[data-page-id]')?.dataset.pageId !== targetPageId
          )
            continue;
          const bounds = candidate.getBoundingClientRect();
          if (
            !bounds.width ||
            !bounds.height ||
            bounds.right <= area.left ||
            bounds.left >= area.right ||
            bounds.bottom <= area.top ||
            bounds.top >= area.bottom
          )
            continue;
          const dx = Math.max(bounds.left - e.clientX, 0, e.clientX - bounds.right),
            dy = Math.max(bounds.top - e.clientY, 0, e.clientY - bounds.bottom),
            d = dx * dx + dy * dy;
          // Both sheets contain a PDF hit in scratch mode. Prefer the foreground
          // PDF there; use the background sheet when the pointer is outside it.
          if (
            d < distance ||
            (d === distance &&
              paper?.classList.contains('scratch-paper') &&
              !candidate.classList.contains('scratch-paper'))
          ) {
            paper = candidate;
            distance = d;
          }
        }
        if (!paper) return;
        const pageId = paper.closest<HTMLElement>('[data-page-id]')?.dataset.pageId ?? null;
        if (targetPageId && pageId !== targetPageId) return;
        const rect = paper.getBoundingClientRect(),
          content = paper.querySelector<HTMLElement>('.reading-content');
        contact.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          rect,
          width: content?.offsetWidth ?? paper.offsetWidth,
          height: content?.offsetHeight ?? paper.offsetHeight,
          pageId,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        setBox(clippedCaptureBox(rect, e.clientX, e.clientY, e.clientX, e.clientY));
      }}
      onPointerMove={(e) => {
        const c = contact.current;
        if (c?.id !== e.pointerId) return;
        setBox(clippedCaptureBox(c.rect, c.x, c.y, e.clientX, e.clientY));
      }}
      onPointerUp={(e) => {
        const c = contact.current;
        if (c?.id !== e.pointerId) return;
        contact.current = null;
        const sampled = clippedCaptureBox(c.rect, c.x, c.y, e.clientX, e.clientY);
        const region = {
          x: ((sampled.x - c.rect.left) / c.rect.width) * c.width,
          y: ((sampled.y - c.rect.top) / c.rect.height) * c.height,
          width: (sampled.width / c.rect.width) * c.width,
          height: (sampled.height / c.rect.height) * c.height,
        };
        if (region.width > 4 && region.height > 4) onCapture(c.pageId, region);
        else setBox(null);
      }}
      onPointerCancel={() => {
        contact.current = null;
        setBox(null);
      }}
      onLostPointerCapture={() => {
        contact.current = null;
        setBox(null);
      }}
    >
      <div className="capture-hint">
        {tr(hint)}
        {onBitmapOcr && <button onClick={onBitmapOcr}>{tr('解析位图')}</button>}
        <button onClick={onClose}>{tr('取消')}</button>
      </div>
      {box && (
        <div
          className="capture-box"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
}
