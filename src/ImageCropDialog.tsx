import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Crop, X } from 'lucide-react';
import type { PlacedImage } from './model';
import { cropPlacedImage, type ImageCropRect } from './imageCrop';
import { t } from './i18n';
import './imageCrop.css';
type CropHandle = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se';
const handles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const handleNames = ['左上角', '上边', '右上角', '右边', '右下角', '下边', '左下角', '左边'];
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
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    before: ImageCropRect;
    mode: 'move' | 'new' | CropHandle;
    moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const owner = useRef<AbortController | null>(null);
  useEffect(() => () => owner.current?.abort(), []);
  const close = () => {
    owner.current?.abort();
    onClose();
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    start.moved ||= Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) >= 3;
    if (!start.moved) return;
    const p = point(event);
    const dx = p.x - start.x,
      dy = p.y - start.y,
      before = start.before;
    const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
    if (start.mode === 'move') {
      setRect({
        ...before,
        x: clamp(before.x + dx, 0, 1 - before.width),
        y: clamp(before.y + dy, 0, 1 - before.height),
      });
    } else if (start.mode === 'new') {
      const x = Math.min(0.999, start.x, p.x),
        y = Math.min(0.999, start.y, p.y);
      setRect({
        x,
        y,
        width: Math.min(1 - x, Math.max(0.001, Math.abs(dx))),
        height: Math.min(1 - y, Math.max(0.001, Math.abs(dy))),
      });
    } else {
      let left = before.x,
        top = before.y,
        right = before.x + before.width,
        bottom = before.y + before.height;
      if (start.mode.includes('w')) left = clamp(left + dx, 0, right - 0.001);
      if (start.mode.includes('e')) right = clamp(right + dx, left + 0.001, 1);
      if (start.mode.includes('n')) top = clamp(top + dy, 0, bottom - 0.001);
      if (start.mode.includes('s')) bottom = clamp(bottom + dy, top + 0.001, 1);
      setRect({ x: left, y: top, width: right - left, height: bottom - top });
    }
  };
  const cancelDrag = (id: number) => {
    if (drag.current?.id !== id) return;
    setRect(drag.current.before);
    drag.current = null;
    setDragging(false);
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
    <div
      className="modal-scrim"
      // Portals still bubble through the document viewport in React. Keep
      // crop gestures here so that touch/hand panning cannot steal capture.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerCancel={(e) => e.stopPropagation()}
      onLostPointerCapture={(e) => e.stopPropagation()}
    >
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
            className={`image-crop-source${dragging ? ' dragging' : ''}`}
            onPointerDown={(e) => {
              if (busy || e.button !== 0 || drag.current) return;
              e.preventDefault();
              const p = point(e),
                handle = (e.target as Element).closest<HTMLElement>('[data-crop-handle]')?.dataset
                  .cropHandle as CropHandle | undefined;
              const inside =
                p.x >= rect.x &&
                p.x <= rect.x + rect.width &&
                p.y >= rect.y &&
                p.y <= rect.y + rect.height;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = {
                id: e.pointerId,
                ...p,
                clientX: e.clientX,
                clientY: e.clientY,
                before: rect,
                mode: handle ?? (inside ? 'move' : 'new'),
                moved: false,
              };
              setDragging(true);
            }}
            onPointerMove={move}
            onPointerUp={(e) => {
              if (drag.current?.id !== e.pointerId) return;
              move(e);
              drag.current = null;
              setDragging(false);
            }}
            onPointerCancel={(e) => cancelDrag(e.pointerId)}
            onLostPointerCapture={(e) => {
              // A touch starts with implicit capture on the region/handle.
              // Transferring that capture to this surface is not cancellation.
              if (e.target === e.currentTarget) cancelDrag(e.pointerId);
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
            >
              {handles.map((handle, index) => (
                <span
                  key={handle}
                  data-crop-handle={handle}
                  className={`image-crop-handle ${handle}`}
                  aria-label={t('调整裁剪框{0}', t(handleNames[index]))}
                />
              ))}
            </div>
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
