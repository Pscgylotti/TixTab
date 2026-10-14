import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { Page } from './model';
import { bitmapSelectionWords, bitmapTextLines } from './bitmapText';
import { invalidateTextLayout } from './textSelection';

/** Only mounted for the selection tool. Reuse the native text selection/flyout pipeline. */
const BitmapTextLayer = memo(function BitmapTextLayer({ page }: { page: Page }) {
  const root = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => bitmapTextLines(page), [page.bitmapOcr, page.images]);
  useLayoutEffect(() => {
    const element = root.current!;
    // Batch reads before writes, once per changed OCR layer, never on pointer movement.
    const widths = [...element.querySelectorAll<HTMLElement>('.bitmap-text-word')].map((span) => ({
      span,
      width: span.offsetWidth,
    }));
    for (const { span, width } of widths)
      if (width)
        span.style.setProperty('--ocr-scale-x', String(Number(span.dataset.width) / width));
    const parent = element.closest<HTMLElement>('.textLayer');
    if (parent) invalidateTextLayout(parent);
  }, [lines]);
  return (
    <div ref={root} className="bitmap-text-layer markedContent">
      {lines.map((line) => {
        const words = bitmapSelectionWords(line);
        return (
          <div className="markedContent" key={line.key}>
            {words.map((word, i) => {
              const p = word.polygon,
                dx = p[2] - p[0],
                dy = p[3] - p[1],
                width = Math.hypot(dx, dy),
                height = Math.hypot(p[6] - p[0], p[7] - p[1]),
                separator = (word.after ?? '') + (words[i + 1]?.before ?? '\n');
              if (!width || !height || !word.text.trim()) return null;
              return (
                <span
                  key={i}
                  className="bitmap-text-word"
                  data-width={width}
                  style={
                    {
                      left: p[0],
                      top: p[1],
                      fontSize: height,
                      '--rotate': `${(Math.atan2(dy, dx) * 180) / Math.PI}deg`,
                      transform: `matrix(${dx / width},${dy / width},${(p[6] - p[0]) / height},${(p[7] - p[1]) / height},0,0) scaleX(var(--ocr-scale-x, 1))`,
                    } as React.CSSProperties
                  }
                >
                  {word.text}
                  {/* Render separators inside each positioned word. Bare whitespace between
                      absolute boxes is collapsed out of Chromium's Selection/clipboard text.
                      The absolute child preserves spacing without changing word measurements. */}
                  {separator && (
                    <span
                      className="bitmap-text-separator"
                      style={{
                        left: '100%',
                        top: 0,
                        fontSize: 'inherit',
                        transform: 'none',
                        pointerEvents: 'none',
                      }}
                    >
                      {separator}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});
export default BitmapTextLayer;
