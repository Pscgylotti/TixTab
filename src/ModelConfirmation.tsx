import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Trash2 } from 'lucide-react';
import { t, useLocale } from './i18n';

type ModelInfo = { id: string; name: string; bytes: number; source: string; license: string };
export default function ModelConfirmation({
  model,
  remove,
  onConfirm,
  onCancel,
}: {
  model: ModelInfo;
  remove: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useLocale();
  const panel = useRef<HTMLElement>(null),
    cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLButtonElement>('.model-confirm-cancel')?.focus(),
    );
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel.current();
      }
      if (event.key === 'Tab') {
        const controls = Array.from(
          panel.current?.querySelectorAll<HTMLElement>('button,a[href]') || [],
        );
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', key, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="model-confirm-scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={panel}
        className="modal model-confirm model-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="model-confirm-title"
        aria-describedby="model-confirm-description"
      >
        <header>
          <h2 id="model-confirm-title">{t(remove ? '删除下载副本？' : '下载模型？')}</h2>
          <button className="icon-button" aria-label={t('取消')} onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <div className="model-confirm-body">
          <strong>{model.name}</strong>
          <p>{(model.bytes / 1024 / 1024).toFixed(1)} MiB</p>
          <p id="model-confirm-description">
            {t(
              remove
                ? '仅删除此模型的下载副本。内置权重和文档不受影响；没有内置权重时需重新下载才能离线使用。'
                : '将从模型来源下载固定版本，并核对每个文件的 SHA256。',
            )}
          </p>
          {!remove && (
            <>
              <p>{t('模型许可独立于应用许可，请先阅读模型来源及许可说明。')}</p>
              <p className="model-confirm-license">{model.license}</p>
              <a href={model.source} target="_blank" rel="noreferrer">
                {t('模型来源')}
              </a>
            </>
          )}
        </div>
        <footer>
          <button className="model-confirm-cancel" onClick={onCancel}>
            {t('取消')}
          </button>
          <button className="primary" onClick={onConfirm}>
            {remove ? <Trash2 size={16} /> : <Download size={16} />}{' '}
            {t(remove ? '确认删除' : '确认下载')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
