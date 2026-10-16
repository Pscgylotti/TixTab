import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Page } from './model';
import { t, useLocale } from './i18n';
import NativePdfLayer from './NativePdfLayer';
import PdfObjectLayer from './PdfObjectLayer';

/** Remembered while the window is open, like the other per-tool choices. */
let lastMode: 'objects' | 'content' = 'objects';

/** The PDF 元素 tool: object editing on PDFium by default; text content and
 * image replacement still go through the PyMuPDF editor. */
export default function PdfEditLayer({
  page,
  zoom,
  active,
  host,
}: {
  page: Page;
  zoom: number;
  active: boolean;
  host: HTMLElement | null;
}) {
  useLocale();
  const [mode, setModeState] = useState(lastMode);
  const setMode = (value: typeof mode) => {
    lastMode = value;
    setModeState(value);
  };
  if (mode === 'objects')
    return (
      <PdfObjectLayer
        page={page}
        zoom={zoom}
        active={active}
        host={host}
        onEditText={() => setMode('content')}
      />
    );
  return (
    <>
      <NativePdfLayer page={page} zoom={zoom} active={active} />
      {active &&
        host &&
        createPortal(
          <div
            className="object-inspector pdf-object-inspector"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span>{t('编辑文字内容与替换图片')}</span>
            <button onClick={() => setMode('objects')}>{t('返回对象编辑')}</button>
          </div>,
          host,
        )}
    </>
  );
}
