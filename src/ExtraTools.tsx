import { lazy, useEffect, useState } from 'react';
import { Wrench, Images, ScanLine, ScanText, Music, Camera } from 'lucide-react';
import type { Notebook, Page } from './model';
import { uid } from './model';
import type { MusicPlayerState } from './musicPlayerState';
import type { PDFDocumentProxy } from './pdfTypes';
import AnchoredPopover from './AnchoredPopover';
import { t } from './i18n';
import FeatureBoundary from './FeatureBoundary';
const LocalDocumentToolDialog = lazy(() => import('./LocalDocumentToolDialog'));
const MusicPlayer = lazy(() => import('./MusicPlayer'));
const ImageExportDialog = lazy(() => import('./ImageExportDialog'));
const CameraDialog = lazy(() => import('./CameraDialog'));
export default function ExtraTools({
  notebook,
  pdf,
  index,
  disabled,
  onApply,
  onNavigate,
  onBackground,
  onJobClose,
  active = true,
  presentation = false,
  onPlayerChange,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  disabled: boolean;
  onApply: (pages: Page[], bases: Page[], origin: Notebook) => void | Promise<void>;
  onNavigate: (index: number) => void;
  onBackground?: (hidden: boolean) => void;
  onJobClose?: () => void;
  active?: boolean;
  presentation?: boolean;
  onPlayerChange: (change: Partial<MusicPlayerState>) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null),
    [images, setImages] = useState(false),
    [camera, setCamera] = useState(false),
    [local, setLocal] = useState<'correct' | 'music' | null>(null);
  useEffect(() => {
    if (!active) setCamera(false);
  }, [active]);
  const player = notebook.musicPlayer?.open ?? false;
  const setPlayer = (open: boolean) => onPlayerChange({ open });
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
                setCamera(true);
              }}
            >
              <Camera size={17} aria-hidden="true" />
              {t('拍照')}
            </button>
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
              <ScanLine size={17} aria-hidden="true" />
              {t('文档矫正')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setAnchor(null);
                setLocal('music');
              }}
            >
              <ScanText size={17} aria-hidden="true" />
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
              <Music size={17} aria-hidden="true" />
              {t('五线谱播放器')}
            </button>
          </div>
        </AnchoredPopover>
      )}
      {camera && active && (
        <FeatureBoundary name={t('拍照')} onClose={() => setCamera(false)}>
          <CameraDialog
            onClose={() => setCamera(false)}
            onInsert={async (data, width, height) => {
              const page = notebook.pages[index];
              if (!page) throw new Error('page-unavailable');
              const scale = Math.min((page.width * 0.8) / width, (page.height * 0.65) / height, 1),
                w = width * scale,
                h = height * scale;
              await onApply(
                [
                  {
                    ...page,
                    images: [
                      ...page.images,
                      {
                        id: uid(),
                        kind: 'image',
                        data,
                        x: (page.width - w) / 2,
                        y: (page.height - h) / 2,
                        width: w,
                        height: h,
                      },
                    ],
                  },
                ],
                notebook.pages,
                notebook,
              );
            }}
          />
        </FeatureBoundary>
      )}
      {local && (
        <FeatureBoundary
          key={local}
          name={t(local === 'correct' ? '文档矫正' : '五线谱识别')}
          onClose={() => {
            setLocal(null);
            onJobClose?.();
          }}
        >
          <LocalDocumentToolDialog
            kind={local}
            notebook={notebook}
            pdf={pdf}
            index={index}
            onApply={onApply}
            onClose={() => {
              setLocal(null);
              onJobClose?.();
            }}
            onVisibility={onBackground}
            onRecognized={() => setPlayer(true)}
          />
        </FeatureBoundary>
      )}
      {player && active && (
        <FeatureBoundary name={t('五线谱播放器')} onClose={() => setPlayer(false)}>
          <MusicPlayer
            key={notebook.batch?.itemId ?? notebook.pages[0].id}
            notebook={notebook}
            presentation={presentation}
            onStateChange={onPlayerChange}
            onApply={(pages) => {
              void onApply(pages, notebook.pages, notebook);
            }}
            onNavigate={onNavigate}
            onClose={() => setPlayer(false)}
          />
        </FeatureBoundary>
      )}
      {images && (
        <FeatureBoundary
          name={t('提取图片')}
          onClose={() => {
            setImages(false);
            onJobClose?.();
          }}
        >
          <ImageExportDialog
            notebook={notebook}
            pdf={pdf}
            index={index}
            onClose={() => {
              setImages(false);
              onJobClose?.();
            }}
            onVisibility={onBackground}
          />
        </FeatureBoundary>
      )}
    </>
  );
}
