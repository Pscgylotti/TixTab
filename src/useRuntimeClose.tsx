import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRuntimeInstall, cancelRuntime } from './runtimeInstall';
import type { RuntimeId } from './runtimeBridge';
import { t, useLocale } from './i18n';
import './runtimeInstall.css';
export function useRuntimeClose(onClose: () => void, id?: RuntimeId, onBackground?: () => void) {
  useLocale();
  const state = useRuntimeInstall(),
    [pending, setPending] = useState(false),
    root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pending) return;
    const prior = document.activeElement as HTMLElement;
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => prior?.focus();
  }, [pending]);
  const close = () =>
    state.active && (!id || state.active === id)
      ? onBackground
        ? onBackground()
        : setPending(true)
      : onClose();
  const confirmation = pending
    ? createPortal(
        <div
          className="runtime-close-scrim"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setPending(false);
            if (e.key === 'Tab') {
              const buttons = Array.from(root.current!.querySelectorAll('button'));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              e.preventDefault();
              buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
            }
          }}
        >
          <section
            className="runtime-close-dialog"
            ref={root}
            role="alertdialog"
            aria-modal="true"
            aria-label={t('关闭安装面板')}
          >
            <h2>{t('关闭安装面板')}</h2>
            <p>{t('关闭面板后是否继续后台安装？')}</p>
            <p>{t('后台安装会在应用保持运行时继续，可在模型管理中查看进度和日志。')}</p>
            <div>
              <button
                className="primary"
                onClick={() => {
                  setPending(false);
                  onClose();
                }}
              >
                {t('后台继续安装')}
              </button>
              <button
                onClick={() => {
                  void cancelRuntime();
                  setPending(false);
                  onClose();
                }}
              >
                {t('取消安装并关闭')}
              </button>
              <button onClick={() => setPending(false)}>{t('返回')}</button>
            </div>
          </section>
        </div>,
        document.body,
      )
    : null;
  return { close, confirmation };
}
