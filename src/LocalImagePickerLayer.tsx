import { useEffect, useState } from 'react';
import type { Page } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import { correctionTargets, type CorrectionTarget } from './documentCorrection';
import { pickLocalImage, useLocalImagePicker } from './localImagePicker';
import { t } from './i18n';
export default function LocalImagePickerLayer({
  page,
  pdf,
}: {
  page: Page;
  pdf: PDFDocumentProxy | null;
}) {
  const active = useLocalImagePicker(),
    [targets, setTargets] = useState<CorrectionTarget[]>([]);
  useEffect(() => {
    if (!active) return;
    const a = new AbortController();
    void correctionTargets([page], pdf, false, a.signal)
      .then((r) => {
        if (!a.signal.aborted) setTargets(r);
      })
      .catch(() => {});
    return () => a.abort();
  }, [active, page, pdf]);
  if (!active) return null;
  return (
    <svg
      className="local-image-picker"
      viewBox={`0 0 ${page.width} ${page.height}`}
      aria-label={t('选择矫正图片')}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {targets.map((target, i) => (
        <polygon
          key={i}
          points={target.polygon.reduce((s, n, i) => s + (i % 2 ? ',' : ' ') + n, '').trim()}
          fill="transparent"
          stroke="#4775db"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          tabIndex={0}
          role="button"
          aria-label={t('矫正图片 {0}', i + 1)}
          onClick={(e) => {
            e.stopPropagation();
            pickLocalImage(target);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') pickLocalImage(target);
          }}
        />
      ))}
    </svg>
  );
}
