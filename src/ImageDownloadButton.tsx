import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { t } from './i18n';
import { canvasPng, saveImageBlob } from './imageDownload';
export default function ImageDownloadButton({
  source,
  name,
  disabled,
  compact,
  onError,
}: {
  source: string | (() => HTMLCanvasElement | null);
  name: string;
  disabled?: boolean;
  compact?: boolean;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  return (
    <button
      className={compact ? 'icon-button' : undefined}
      disabled={disabled || busy}
      aria-label={t('下载图片')}
      title={t('下载图片')}
      onClick={async () => {
        if (active.current) return;
        const owner = new AbortController();
        active.current = owner;
        setBusy(true);
        try {
          const canvas = typeof source === 'function' ? source() : null;
          const blob =
            typeof source === 'string'
              ? await (await fetch(source, { signal: owner.signal })).blob()
              : canvas
                ? await canvasPng(canvas)
                : null;
          owner.signal.throwIfAborted();
          if (!blob) throw Error('image-not-ready');
          saveImageBlob(blob, name);
        } catch {
          if (!owner.signal.aborted) onError(t('图片下载失败，请重试。'));
        } finally {
          if (active.current === owner) {
            active.current = null;
            if (!owner.signal.aborted) setBusy(false);
          }
        }
      }}
    >
      <Download size={compact ? 18 : 16} />
      {!compact && t('下载图片')}
    </button>
  );
}
