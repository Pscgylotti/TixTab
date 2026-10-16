import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { t } from './i18n';
import { copyCanvasImage } from './clipboard';
export default function ImageCopyButton({
  source,
  disabled,
  onStatus,
}: {
  source: () => HTMLCanvasElement | null;
  disabled?: boolean;
  onStatus: (message: string) => void;
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
      className="icon-button"
      aria-label={t('复制图片')}
      title={t('复制图片')}
      disabled={disabled || busy}
      onClick={async () => {
        const c = source();
        if (!c || active.current) return;
        const owner = new AbortController();
        active.current = owner;
        setBusy(true);
        try {
          await copyCanvasImage(c, owner.signal);
          if (!owner.signal.aborted) onStatus(t('图片已复制，可粘贴到聊天或其它应用。'));
        } catch {
          if (!owner.signal.aborted) onStatus(t('图片复制失败，请检查剪贴板权限后重试。'));
        } finally {
          if (active.current === owner) {
            active.current = null;
            if (!owner.signal.aborted) setBusy(false);
          }
        }
      }}
    >
      <Copy size={18} />
    </button>
  );
}
