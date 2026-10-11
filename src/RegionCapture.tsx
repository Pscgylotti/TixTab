import { t as tr, useLocale } from './i18n';
import { useRef, useState } from 'react';
import type { PageRegion } from './capturePage';
export default function RegionCapture({
  onCapture,
  onClose,
}: {
  onCapture: (pageId: string | null, region: PageRegion) => void;
  onClose: () => void;
}) {
  useLocale();
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
      aria-label={tr('框选识别区域')}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button') || contact.current) return;
        const paper = document
          .elementsFromPoint(e.clientX, e.clientY)
          .find((el) => el.matches('.paper,.reading-paper')) as HTMLElement | undefined;
        if (!paper) return;
        const rect = paper.getBoundingClientRect(),
          content = paper.querySelector<HTMLElement>('.reading-content');
        contact.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          rect,
          width: content?.offsetWidth ?? paper.offsetWidth,
          height: content?.offsetHeight ?? paper.offsetHeight,
          pageId: paper.closest<HTMLElement>('[data-page-id]')?.dataset.pageId ?? null,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        setBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
      }}
      onPointerMove={(e) => {
        const c = contact.current;
        if (c?.id !== e.pointerId) return;
        const x = Math.max(c.rect.left, Math.min(c.rect.right, e.clientX)),
          y = Math.max(c.rect.top, Math.min(c.rect.bottom, e.clientY));
        setBox({
          x: Math.min(c.x, x),
          y: Math.min(c.y, y),
          width: Math.abs(x - c.x),
          height: Math.abs(y - c.y),
        });
      }}
      onPointerUp={(e) => {
        const c = contact.current;
        if (c?.id !== e.pointerId) return;
        contact.current = null;
        const x = Math.max(c.rect.left, Math.min(c.rect.right, e.clientX)),
          y = Math.max(c.rect.top, Math.min(c.rect.bottom, e.clientY));
        const region = {
          x: ((Math.min(c.x, x) - c.rect.left) / c.rect.width) * c.width,
          y: ((Math.min(c.y, y) - c.rect.top) / c.rect.height) * c.height,
          width: (Math.abs(x - c.x) / c.rect.width) * c.width,
          height: (Math.abs(y - c.y) / c.rect.height) * c.height,
        };
        if (region.width > 4 && region.height > 4) onCapture(c.pageId, region);
        else setBox(null);
      }}
      onPointerCancel={() => {
        contact.current = null;
        setBox(null);
      }}
    >
      <div className="capture-hint">
        {tr('拖动框选文字或公式')}
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
