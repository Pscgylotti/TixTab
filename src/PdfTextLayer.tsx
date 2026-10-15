import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { trackPerformance } from './performanceLedger';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { readPdfTextContent } from './pdfTextContent';
import { renderPdfTextDom } from './pdfTextDom';
import type { Page } from './model';
import BitmapTextLayer from './BitmapTextLayer';
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
  page: notebookPage,
}: {
  pdf: PDFDocumentProxy | null;
  sourceIndex: number | null;
  page?: Page;
}) {
  const root = useRef<HTMLDivElement>(null);
  const nativeRoot = useRef<HTMLDivElement>(null);
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
    let cancelled = false;
    const element = nativeRoot.current!;
    selecting.current = null;
    hidePreview();
    invalidateTextLayout(root.current!);
    element.replaceChildren();
    if (pdf && sourceIndex !== null)
      void trackPerformance('pdf-text', () =>
        pdf.getPage(sourceIndex + 1).then(async (page) => {
          const content = await readPdfTextContent(pdf, sourceIndex, page);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1 });
          renderPdfTextDom(element, content, viewport);
          invalidateTextLayout(root.current!);
        }),
      ).catch(() => {});
    return () => {
      cancelled = true;
      element.replaceChildren();
    };
  }, [pdf, sourceIndex]);
  return (
    <>
      <div
        className="textLayer"
        ref={root}
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
      >
        <div ref={nativeRoot} className="pdf-native-text" />
        {notebookPage && <BitmapTextLayer page={notebookPage} />}
      </div>
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
