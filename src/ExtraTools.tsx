import { lazy, Suspense, useState } from 'react';
import { Wrench, Images } from 'lucide-react';
import type { Notebook, Page } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import AnchoredPopover from './AnchoredPopover';
import { t } from './i18n';
const LocalDocumentToolDialog = lazy(() => import('./LocalDocumentToolDialog'));
const MusicPlayer = lazy(() => import('./MusicPlayer'));
const ImageExportDialog = lazy(() => import('./ImageExportDialog'));
export default function ExtraTools({
  notebook,
  pdf,
  index,
  disabled,
  onApply,
  onNavigate,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  disabled: boolean;
  onApply: (pages: Page[]) => void;
  onNavigate: (index: number) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null),
    [images, setImages] = useState(false),
    [local, setLocal] = useState<'correct' | 'music' | null>(null),
    [player, setPlayer] = useState(false);
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
            <button
              role="menuitem"
              onClick={() => {
                setAnchor(null);
                setLocal('correct');
              }}
            >
              {t('文档矫正')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setAnchor(null);
                setLocal('music');
              }}
            >
              {t('五线谱识别')}
            </button>
            <button
              role="menuitem"
              disabled={!notebook.pages.some((p) => p.score)}
              onClick={() => {
                setAnchor(null);
                setPlayer(true);
              }}
            >
              {t('五线谱播放器')}
            </button>
          </div>
        </AnchoredPopover>
      )}
      {local && (
        <Suspense fallback={null}>
          <LocalDocumentToolDialog
            kind={local}
            notebook={notebook}
            pdf={pdf}
            index={index}
            onApply={onApply}
            onClose={() => setLocal(null)}
            onRecognized={() => setPlayer(true)}
          />
        </Suspense>
      )}
      {player && (
        <Suspense fallback={null}>
          <MusicPlayer
            notebook={notebook}
            onApply={onApply}
            onNavigate={onNavigate}
            onClose={() => setPlayer(false)}
          />
        </Suspense>
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
