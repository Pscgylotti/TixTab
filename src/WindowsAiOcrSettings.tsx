import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { windowsAiError } from './windowsAiOcr';
export default function WindowsAiOcrSettings({ disabled = false }: { disabled?: boolean }) {
  const [status, setStatus] = useState(''),
    [checking, setChecking] = useState(false);
  const id = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (id.current)
        void window.surfaceDesktop?.windowsAiOcr?.run({ action: 'close', id: id.current });
      id.current = null;
    },
    [],
  );
  const check = async () => {
    const requestId = crypto.randomUUID();
    id.current = requestId;
    setChecking(true);
    try {
      const result = await window.surfaceDesktop?.windowsAiOcr?.run({
        action: 'status',
        id: requestId,
      });
      if (id.current !== requestId) return;
      setStatus(
        result?.ok
          ? result.state === 'Ready'
            ? t('系统模型已就绪')
            : result.state === 'NotReady'
              ? t('系统模型未就绪；开始识别时由 Windows 准备或下载。')
              : windowsAiError(result.state)
          : windowsAiError(result?.error, result?.hresult),
      );
    } catch {
      if (id.current === requestId) setStatus(windowsAiError());
    } finally {
      if (id.current === requestId) {
        id.current = null;
        setChecking(false);
      }
    }
  };
  const register = async () => {
    const requestId = crypto.randomUUID();
    id.current = requestId;
    setChecking(true);
    try {
      const result = await window.surfaceDesktop?.windowsAiOcr?.run({
        action: 'register',
        id: requestId,
      });
      if (id.current === requestId) {
        if (result?.ok) await check();
        else setStatus(windowsAiError(result?.error));
      }
    } catch {
      if (id.current === requestId) setStatus(windowsAiError('windows-ai-registration-failed'));
    } finally {
      if (id.current === requestId) {
        id.current = null;
        setChecking(false);
      }
    }
  };
  return (
    <div className="native-settings">
      <p className="muted">
        {t(
          '需要受支持的 Windows 11 与 NPU。系统管理模型，首次使用可能下载；串行识别，保留词和行的位置。',
        )}
      </p>
      <button
        disabled={disabled || checking || !window.surfaceDesktop?.windowsAiOcr}
        onClick={() => void check()}
      >
        {t('检查 Windows AI 可用性')}
      </button>
      <button
        disabled={disabled || checking || !window.surfaceDesktop?.windowsAiOcr}
        onClick={() => void register()}
      >
        {t('注册 OCR 组件权限')}
      </button>
      {status && <p role="status">{status}</p>}
    </div>
  );
}
