import { useState } from 'react';
import { Copy, ScanText, X } from 'lucide-react';
import { copyImage } from './clipboard';
import { t, useLocale } from './i18n';
import ImageDownloadButton from './ImageDownloadButton';

export default function CapturePreview({
  image,
  onOcr,
  onClose,
}: {
  image: string;
  onOcr: () => void;
  onClose: () => void;
}) {
  useLocale();
  const [status, setStatus] = useState('');
  const [copying, setCopying] = useState(false);
  return (
    <div
      className="modal-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        className="modal capture-preview"
        role="dialog"
        aria-modal="true"
        aria-label={t('截图预览')}
      >
        <header>
          <h2>{t('截图预览')}</h2>
          <button autoFocus aria-label={t('关闭')} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <img className="capture-preview-image" src={image} alt={t('选中区域')} />
        <footer>
          <ImageDownloadButton source={image} name="TixTab-capture.png" onError={setStatus} />
          <button
            disabled={copying}
            onClick={async () => {
              setCopying(true);
              try {
                await copyImage(image);
                setStatus(t('图片已复制，可粘贴到聊天或其它应用。'));
              } catch {
                setStatus(t('图片复制失败，请检查剪贴板权限后重试。'));
              } finally {
                setCopying(false);
              }
            }}
          >
            <Copy size={16} />
            {t('复制图片')}
          </button>
          <button className="primary" onClick={onOcr}>
            <ScanText size={16} />
            {t('识别文字（OCR）')}
          </button>
        </footer>
        <p role="status">{status}</p>
      </section>
    </div>
  );
}
