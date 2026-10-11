import { t as tr, useLocale } from './i18n';
import { useAppearance } from './appearance';
import { useRef, useState } from 'react';
import {
  Excalidraw,
  exportToCanvas,
  exportToSvg,
  convertToExcalidrawElements,
} from '@excalidraw/excalidraw';
import type { PlacedImage } from './model';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
interface Props {
  scene?: Record<string, unknown>;
  bitmap?: PlacedImage;
  editing?: boolean;
  onClose: (scene?: Record<string, unknown>) => void;
  onInsert: (
    data: string,
    width: number,
    height: number,
    scene: Record<string, unknown>,
    displayData: string,
  ) => void;
}
export default function SketchDialog({ scene, bitmap, editing, onClose, onInsert }: Props) {
  const locale = useLocale();
  const { night } = useAppearance();
  const api = useRef<ExcalidrawImperativeAPI | null>(null),
    [error, setError] = useState('');
  const snapshot = () =>
    api.current
      ? {
          elements: api.current.getSceneElements(),
          files: api.current.getFiles(),
          appState: { viewBackgroundColor: '#ffffff' },
        }
      : scene;
  const [initialData] = useState(
    () =>
      scene ??
      (bitmap
        ? {
            elements: convertToExcalidrawElements([
              {
                type: 'image',
                x: 0,
                y: 0,
                width: bitmap.width,
                height: bitmap.height,
                fileId: 'legacy-image' as never,
              },
            ]),
            files: {
              'legacy-image': {
                id: 'legacy-image',
                dataURL: bitmap.data,
                mimeType: 'image/png',
                created: Date.now(),
              },
            },
          }
        : undefined),
  );
  return (
    <div className="modal-scrim">
      <section
        className="modal sketch-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tr('Excalidraw 草图')}
      >
        <header>
          <div>
            <h2>{tr('自由构想')}</h2>
            <p>
              {bitmap
                ? tr('旧工程仅有图片：可移动图片、添加新图形；原矢量元素无法还原。')
                : tr('Excalidraw · 保留矢量显示与可编辑场景')}
            </p>
          </div>
          <div className="row">
            <span className="error">{tr(error)}</span>
            <button onClick={() => onClose(editing ? undefined : snapshot())}>
              {editing ? tr('取消') : tr('保存草图并关闭')}
            </button>
            <button
              className="primary"
              onClick={async () => {
                try {
                  if (!api.current?.getSceneElements().length) {
                    setError(tr('先画一点内容'));
                    return;
                  }
                  const elements = api.current.getSceneElements(),
                    files = api.current.getFiles(),
                    appState = { exportBackground: false, exportWithDarkMode: false };
                  let logicalWidth = 0,
                    logicalHeight = 0;
                  const canvas = await exportToCanvas({
                    elements,
                    files,
                    appState,
                    getDimensions: (width: number, height: number) => {
                      logicalWidth = width;
                      logicalHeight = height;
                      const scale = Math.min(
                        6,
                        3200 / Math.max(width, height),
                        Math.sqrt(8_000_000 / (width * height)),
                      );
                      return {
                        width: Math.ceil(width * scale),
                        height: Math.ceil(height * scale),
                        scale,
                      };
                    },
                  });
                  const svg = await exportToSvg({ elements, files, appState });
                  const displayData = `data:image/svg+xml;base64,${btoa(Array.from(new TextEncoder().encode(svg.outerHTML), (b) => String.fromCharCode(b)).join(''))}`;
                  onInsert(
                    canvas.toDataURL('image/png'),
                    logicalWidth * 2,
                    logicalHeight * 2,
                    snapshot()!,
                    displayData,
                  );
                } catch {
                  setError(tr('草图导出失败，请重试'));
                }
              }}
            >
              {editing ? tr('更新草图') : tr('插入当前页')}
            </button>
          </div>
        </header>
        <div className="sketch-editor">
          <Excalidraw
            theme={night ? 'dark' : 'light'}
            excalidrawAPI={(value) => {
              api.current = value;
            }}
            initialData={initialData}
            langCode={locale === 'en' ? 'en' : 'zh-CN'}
            UIOptions={{ canvasActions: { loadScene: true, export: false, saveAsImage: false } }}
          />
        </div>
      </section>
    </div>
  );
}
