import { t as tr, useLocale } from './i18n';
import { useEffect, useRef } from 'react';
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { glyphAtPoint, selectGlyphs, selectWord, type GlyphHit } from './textSelection';
export default function PdfTextLayer({
  pdf,
  sourceIndex,
}: {
  pdf: PDFDocumentProxy | null;
  sourceIndex: number | null;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null);
  const selecting = useRef<{ id: number; anchor: GlyphHit } | null>(null);
  useEffect(() => {
    let cancelled = false,
      layer: TextLayer | undefined;
    const element = root.current!;
    element.replaceChildren();
    if (pdf && sourceIndex !== null)
      void pdf
        .getPage(sourceIndex + 1)
        .then(async (page) => {
          const content = await page.getTextContent();
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
        })
        .catch(() => {});
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [pdf, sourceIndex]);
  return (
    <div
      className="textLayer"
      ref={root}
      style={{ '--total-scale-factor': 1, '--scale-factor': 1 } as React.CSSProperties}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch' || e.button !== 0 || e.buttons & 34) return;
        const hit = glyphAtPoint(e.currentTarget, e.clientX, e.clientY, true);
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        selecting.current = { id: e.pointerId, anchor: hit };
        selectGlyphs(hit, hit);
      }}
      onPointerMove={(e) => {
        const session = selecting.current;
        if (session?.id !== e.pointerId) return;
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
        if (selecting.current) getSelection()?.removeAllRanges();
        selecting.current = null;
      }}
      onLostPointerCapture={() => {
        selecting.current = null;
      }}
      onDoubleClick={(e) => {
        const hit = glyphAtPoint(e.currentTarget, e.clientX, e.clientY, true);
        if (hit) {
          e.preventDefault();
          selectWord(hit);
        }
      }}
    />
  );
}
