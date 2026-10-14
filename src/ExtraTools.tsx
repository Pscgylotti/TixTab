import { lazy, Suspense, useState } from 'react';
import { Wrench, Images } from 'lucide-react';
import type { Notebook } from './model';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import AnchoredPopover from './AnchoredPopover';
import { t } from './i18n';
const ImageExportDialog = lazy(() => import('./ImageExportDialog'));
export default function ExtraTools({
  notebook,
  pdf,
  index,
  disabled,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  disabled: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null),
    [images, setImages] = useState(false);
  return (
    <>
      <button
        className="icon-button"
        aria-label={t('额外工具')}
        title={t('额外工具')}
        disabled={disabled}
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        <Wrench size={18} />
      </button>
      {anchor && !disabled && (
        <AnchoredPopover
          anchor={anchor}
          label={t('额外工具')}
          width={200}
          onClose={() => setAnchor(null)}
        >
          <div className="extra-tools-menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setAnchor(null);
                setImages(true);
              }}
            >
              <Images size={17} />
              {t('提取图片')}
            </button>
          </div>
        </AnchoredPopover>
      )}
      {images && (
        <Suspense fallback={null}>
          <ImageExportDialog
            notebook={notebook}
            pdf={pdf}
            index={index}
            onClose={() => setImages(false)}
          />
        </Suspense>
      )}
    </>
  );
}
