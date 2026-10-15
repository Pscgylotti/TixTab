import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PlacedImage } from './model';
import { renderColorKey } from './colorKey';
import { t } from './i18n';
import './colorKey.css';
export default function ColorKeyDialog({
  image,
  onApply,
  onClose,
}: {
  image: PlacedImage;
  onApply: (image: PlacedImage) => void;
  onClose: () => void;
}) {
  const original = image.colorKey?.original ?? image.data;
  const [color, setColor] = useState(image.colorKey?.color ?? '#ffffff'),
    [tolerance, setTolerance] = useState(image.colorKey?.tolerance ?? 3),
    [preview, setPreview] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = useRef<AbortController | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      owner.current?.abort();
    };
  }, []);
  useEffect(() => {
    const a = new AbortController(),
      timer = setTimeout(() => {
        void renderColorKey(original, color, tolerance, a.signal, 512)
          .then((p) => {
            if (!a.signal.aborted) setPreview(p);
          })
          .catch(() => {
            if (!a.signal.aborted) setError(t('无法生成透明色预览。'));
          });
      }, 120);
    return () => {
      clearTimeout(timer);
      a.abort();
    };
  }, [original, color, tolerance]);
  const apply = async () => {
    if (owner.current) return;
    const a = new AbortController();
    owner.current = a;
    setBusy(true);
    setError('');
    try {
      const data = await renderColorKey(original, color, tolerance, a.signal);
      if (alive.current)
        onApply({
          ...image,
          data,
          displayData: undefined,
          ocr: undefined,
          colorKey: { original, color, tolerance },
        });
    } catch {
      if (alive.current && !a.signal.aborted) setError(t('无法设置透明色，请重试。'));
    } finally {
      owner.current = null;
      if (alive.current) setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-scrim">
      <section
        className="modal color-key-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('设置透明色')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            owner.current?.abort();
            onClose();
          }
        }}
      >
        <header>
          <h2>{t('设置透明色')}</h2>
          <button
            className="icon-button"
            aria-label={t('关闭透明色设置')}
            onClick={() => {
              owner.current?.abort();
              onClose();
            }}
          >
            <X size={18} />
          </button>
        </header>
        <p>{t('点击原图选取颜色，每个 RGB 通道的差值不超过范围时设为透明。')}</p>
        <div className="color-key-images">
          <figure>
            <figcaption>{t('原图 · 点选颜色')}</figcaption>
            <img
              src={original}
              alt={t('透明色取色图')}
              draggable={false}
              onPointerDown={(e) => {
                if (busy) return;
                const img = e.currentTarget,
                  r = img.getBoundingClientRect(),
                  c = document.createElement('canvas');
                c.width = c.height = 1;
                const ctx = c.getContext('2d')!;
                ctx.drawImage(
                  img,
                  Math.max(
                    0,
                    Math.min(
                      img.naturalWidth - 1,
                      Math.floor(((e.clientX - r.left) * img.naturalWidth) / r.width),
                    ),
                  ),
                  Math.max(
                    0,
                    Math.min(
                      img.naturalHeight - 1,
                      Math.floor(((e.clientY - r.top) * img.naturalHeight) / r.height),
                    ),
                  ),
                  1,
                  1,
                  0,
                  0,
                  1,
                  1,
                );
                const p = ctx.getImageData(0, 0, 1, 1).data;
                setColor(
                  '#' + [p[0], p[1], p[2]].map((v) => v.toString(16).padStart(2, '0')).join(''),
                );
              }}
            />
          </figure>
          <figure>
            <figcaption>{t('透明预览')}</figcaption>
            {preview && <img src={preview} alt={t('透明色预览')} />}
          </figure>
        </div>
        <div className="color-key-controls">
          <input
            type="color"
            aria-label={t('透明颜色')}
            disabled={busy}
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
          <code>{color}</code>
          <label>
            {t('颜色范围')}
            <input
              type="range"
              aria-label={t('透明色范围')}
              min={0}
              max={255}
              step={1}
              value={tolerance}
              disabled={busy}
              onChange={(e) => setTolerance(Number(e.target.value))}
            />
            <output>{tolerance}</output>
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            disabled={busy || !image.colorKey}
            onClick={() =>
              onApply({
                ...image,
                data: original,
                displayData: undefined,
                colorKey: undefined,
                ocr: undefined,
              })
            }
          >
            {t('恢复原图')}
          </button>
          <button className="primary" disabled={busy} onClick={() => void apply()}>
            {t(busy ? '正在处理…' : '应用透明色')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
