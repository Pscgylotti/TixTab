import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { trackPerformance } from './performanceLedger';
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { readPdfTextContent } from './pdfTextContent';
import {
  glyphAtPoint,
  glyphCaret,
  invalidateTextLayout,
  selectGlyphs,
  selectWord,
  type GlyphHit,
} from './textSelection';
export default function PdfTextLayer({
  pdf,
  sourceIndex,
}: {
  pdf: PDFDocumentProxy | null;
  sourceIndex: number | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const selecting = useRef<{ id: number; anchor: GlyphHit } | null>(null);
  const [preview, setPreview] = useState<DOMRect | null>(null);
  const hoverFrame = useRef(0);
  const hidePreview = () => {
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    setPreview(null);
  };
  useEffect(() => {
    const hide = () => hidePreview();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      cancelAnimationFrame(hoverFrame.current);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);
  useEffect(() => {
    let cancelled = false,
      layer: TextLayer | undefined;
    const element = root.current!;
    selecting.current = null;
    hidePreview();
    invalidateTextLayout(element);
    element.replaceChildren();
    if (pdf && sourceIndex !== null)
      void trackPerformance('pdf-text', () =>
        pdf.getPage(sourceIndex + 1).then(async (page) => {
          const content = await readPdfTextContent(pdf, sourceIndex, page);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1 });
          element.style.setProperty('--total-scale-factor', String(viewport.userUnit));
          layer = new TextLayer({ textContentSource: content, container: element, viewport });
          await layer.render();
          if (cancelled) return;
          // The DOM's language-dependent fallback font can differ from canvas.
          // Measure actual layout widths before applying horizontal corrections.
          const minimum = Number(element.style.getPropertyValue('--min-font-size')) || 1;
          const corrections: [HTMLElement, number][] = [];
          let index = 0;
          for (const item of content.items) {
            if (!('str' in item)) continue;
            const span = layer.textDivs[index++];
            if (!span?.style.getPropertyValue('--scale-x') || !item.str) continue;
            const measured = parseFloat(getComputedStyle(span).width) / minimum;
            if (measured > 0)
              corrections.push([
                span,
                (content.styles[item.fontName].vertical ? item.height : item.width) / measured,
              ]);
          }
          for (const [span, scale] of corrections)
            span.style.setProperty('--scale-x', String(scale));
          const dimensions = viewport.rawDims as { pageWidth: number; pageHeight: number };
          element.style.width = `${dimensions.pageWidth * viewport.userUnit}px`;
          element.style.height = `${dimensions.pageHeight * viewport.userUnit}px`;
          invalidateTextLayout(element);
        }),
      ).catch(() => {});
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [pdf, sourceIndex]);
  return (
    <>
      <div
        className="textLayer"
        ref={root}
        style={{ '--total-scale-factor': 1, '--scale-factor': 1 } as React.CSSProperties}
        onPointerDown={(e) => {
          hidePreview();
          if (e.pointerType === 'touch' || e.button !== 0 || e.buttons & 34) return;
          const hit = glyphAtPoint(e.currentTarget, e.clientX, e.clientY, true);
          if (!hit) {
            getSelection()?.removeAllRanges();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          selecting.current = { id: e.pointerId, anchor: hit };
          selectGlyphs(hit, hit);
        }}
        onPointerMove={(e) => {
          const session = selecting.current;
          if (!session) {
            if (e.pointerType === 'touch' || e.buttons) {
              hidePreview();
              return;
            }
            const element = e.currentTarget,
              x = e.clientX,
              y = e.clientY;
            cancelAnimationFrame(hoverFrame.current);
            hoverFrame.current = requestAnimationFrame(() => {
              hoverFrame.current = 0;
              const hit = glyphAtPoint(element, x, y, true);
              const next = hit ? glyphCaret(hit) : null;
              setPreview((old) =>
                old?.x === next?.x &&
                old?.y === next?.y &&
                old?.width === next?.width &&
                old?.height === next?.height
                  ? old
                  : next,
              );
            });
            return;
          }
          if (session.id !== e.pointerId) return;
          e.preventDefault();
          const hit = glyphAtPoint(e.currentTarget, e.clientX, e.clientY);
          if (hit) selectGlyphs(session.anchor, hit);
        }}
        onPointerUp={(e) => {
          const session = selecting.current;
          if (session?.id !== e.pointerId) return;
          const hit = glyphAtPoint(e.currentTarget, e.clientX, e.clientY);
          if (hit) selectGlyphs(session.anchor, hit);
          selecting.current = null;
        }}
        onPointerCancel={() => {
          hidePreview();
          if (selecting.current) getSelection()?.removeAllRanges();
          selecting.current = null;
        }}
        onLostPointerCapture={() => {
          selecting.current = null;
        }}
        onPointerLeave={hidePreview}
        onDoubleClick={(e) => {
          const hit = glyphAtPoint(e.currentTarget, e.clientX, e.clientY, true);
          if (hit) {
            e.preventDefault();
            selectWord(hit);
          }
        }}
      />
      {preview &&
        createPortal(
          <div
            className="pdf-selection-caret"
            aria-hidden="true"
            style={{
              left: preview.left,
              top: preview.top,
              width: Math.max(1, preview.width),
              height: Math.max(1, preview.height),
            }}
          />,
          document.body,
        )}
    </>
  );
}
