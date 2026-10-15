import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Crop, X } from 'lucide-react';
import type { PlacedImage } from './model';
import { cropPlacedImage, type ImageCropRect } from './imageCrop';
import { t } from './i18n';
import './imageCrop.css';
export default function ImageCropDialog({
  image,
  onApply,
  onClose,
}: {
  image: PlacedImage;
  onApply: (image: PlacedImage) => void;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<ImageCropRect>(
    image.crop?.rect ?? { x: 0, y: 0, width: 1, height: 1 },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const drag = useRef<{ id: number; x: number; y: number; before: ImageCropRect } | null>(null);
  const owner = useRef<AbortController | null>(null);
  useEffect(() => () => owner.current?.abort(), []);
  const close = () => {
    owner.current?.abort();
    onClose();
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(0.999999, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(0.999999, (event.clientY - box.top) / box.height)),
    };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const p = point(event);
    setRect({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.min(1 - Math.min(start.x, p.x), Math.max(0.001, Math.abs(p.x - start.x))),
      height: Math.min(1 - Math.min(start.y, p.y), Math.max(0.001, Math.abs(p.y - start.y))),
    });
  };
  const apply = async () => {
    if (owner.current) return;
    const controller = new AbortController();
    owner.current = controller;
    setBusy(true);
    setError('');
    try {
      const next = await cropPlacedImage(image, rect, controller.signal);
      if (!controller.signal.aborted) onApply(next);
    } catch {
      if (!controller.signal.aborted) setError(t('无法裁剪图片，请重试。'));
    } finally {
      if (!controller.signal.aborted) {
        owner.current = null;
        setBusy(false);
      }
    }
  };
  return createPortal(
    <div className="modal-scrim">
      <section
        className="modal image-crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('裁剪图片')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <header>
          <h2>
            <Crop size={20} />
            {t('裁剪图片')}
          </h2>
          <button className="icon-button" aria-label={t('关闭图片裁剪')} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div className="image-crop-stage">
          <div
            className="image-crop-source"
            onPointerDown={(e) => {
              if (busy || e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { id: e.pointerId, ...point(e), before: rect };
            }}
            onPointerMove={move}
            onPointerUp={(e) => {
              move(e);
              drag.current = null;
            }}
            onPointerCancel={() => {
              if (drag.current) setRect(drag.current.before);
              drag.current = null;
            }}
          >
            <img
              src={image.crop?.original ?? image.colorKey?.original ?? image.data}
              alt={t('裁剪原图')}
              draggable={false}
            />
            <div
              className="image-crop-region"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
              }}
            />
          </div>
        </div>
        <div className="image-crop-values">
          {(['x', 'y', 'width', 'height'] as const).map((key, index) => (
            <label key={key}>
              {t(['左侧', '顶部', '宽度', '高度'][index])} %
              <input
                aria-label={t(['裁剪左侧', '裁剪顶部', '裁剪宽度', '裁剪高度'][index])}
                type="number"
                min={key === 'x' || key === 'y' ? 0 : 0.1}
                max={100}
                step={0.1}
                value={Number((rect[key] * 100).toFixed(1))}
                disabled={busy}
                onChange={(e) => {
                  const value = Math.max(
                    key === 'x' || key === 'y' ? 0 : 0.001,
                    Math.min(1, Number(e.target.value) / 100),
                  );
                  setRect((r) =>
                    key === 'x'
                      ? { ...r, x: Math.min(value, 1 - r.width) }
                      : key === 'y'
                        ? { ...r, y: Math.min(value, 1 - r.height) }
                        : key === 'width'
                          ? { ...r, width: Math.min(value, 1 - r.x) }
                          : { ...r, height: Math.min(value, 1 - r.y) },
                  );
                }}
              />
            </label>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button disabled={busy} onClick={() => setRect({ x: 0, y: 0, width: 1, height: 1 })}>
            {t('恢复完整图片')}
          </button>
          <button disabled={busy} onClick={() => void apply()}>
            {t(busy ? '正在处理…' : '应用裁剪')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
