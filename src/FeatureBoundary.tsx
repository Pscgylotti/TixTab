import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { t } from './i18n';
import './featureBoundary.css';

type Props = { name: string; onClose: () => void; children: ReactNode };

/** A failed optional tool must not unmount the notebook or its save controls. */
export default class FeatureBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Optional tool failed:', this.props.name, error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    const { name, onClose, children } = this.props;
    if (!error)
      return (
        <Suspense fallback={<ToolMessage name={name} onClose={onClose} />}>{children}</Suspense>
      );
    const staleAsset =
      /dynamically imported|module script|loading (?:css )?chunk|importing a module/i.test(
        error.message,
      );
    return (
      <ToolMessage name={name} onClose={onClose}>
        <p>{t('此工具暂时无法打开，文档仍可继续编辑和保存。')}</p>
        <p>
          {t(
            staleAsset
              ? '应用文件可能已更新。请关闭此提示，保存工程后重新打开应用。'
              : '请关闭此提示后重试；若仍失败，请提供下方错误详情。',
          )}
        </p>
        <details>
          <summary>{t('错误详情')}</summary>
          <pre>{error.message.slice(0, 2000)}</pre>
        </details>
      </ToolMessage>
    );
  }
}

function ToolMessage({
  name,
  onClose,
  children,
}: Omit<Props, 'children'> & { children?: ReactNode }) {
  return createPortal(
    <div className="modal-scrim feature-message-scrim">
      <section className="feature-message" role="dialog" aria-modal="true" aria-label={name}>
        <header>
          <strong>{name}</strong>
          <button className="icon-button" onClick={onClose} aria-label={t('关闭')}>
            <X size={20} />
          </button>
        </header>
        {children || <p role="status">{t('正在打开工具…')}</p>}
        <footer>
          <button className="primary" onClick={onClose}>
            {t('关闭')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
