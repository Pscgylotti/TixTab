import { useEffect, useRef, useState } from 'react';
import { t as tr } from './i18n';
import { destination } from './remoteProvider';
import { executeProvider, providerFailureStatus } from './providers';
import { usesDesktopRelay } from './providerTransport';
import type {
  ProviderConfig,
  ProviderFeature,
  ProviderProfile,
  StorageStatus,
} from './providerSettings';
export function ProviderAdvanced({
  feature,
  provider,
  patch,
  ready,
  storageStatus,
  save,
  forget,
  disabled = false,
}: {
  feature: ProviderFeature;
  provider: ProviderConfig;
  patch: (p: Partial<ProviderProfile>) => void;
  ready: boolean;
  storageStatus: StorageStatus;
  save: () => Promise<void>;
  forget: () => void;
  disabled?: boolean;
}) {
  const [checking, setChecking] = useState(false),
    [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    controller.current?.abort();
    setChecking(false);
    setStatus('');
  }, [provider.type, provider.url, provider.key, provider.headers]);
  const test = async () => {
    const current = new AbortController();
    controller.current = current;
    setChecking(true);
    setStatus('');
    try {
      const result = await executeProvider(
        { config: provider, feature, operation: 'check' },
        { signal: current.signal },
      );
      if (!current.signal.aborted)
        setStatus(tr('服务器可达（HTTP {0}），请使用实际任务验证接口格式。', result.httpStatus));
    } catch (e) {
      if (!current.signal.aborted) setStatus(providerFailureStatus(e, true));
    } finally {
      if (controller.current === current) setChecking(false);
    }
  };
  const names: Record<StorageStatus, string> = {
    loading: '正在读取后端配置…',
    pending: '正在保存后端配置…',
    encrypted: '密钥及请求头已加密保存在本机',
    session: '浏览器中的密钥、请求头和 URL 查询参数仅本次会话有效',
    error: '加密配置未能保存或读取；当前修改仅在本次会话有效',
  };
  return (
    <details className="provider-advanced">
      <summary>{tr('API 高级设置')}</summary>
      <fieldset disabled={!ready || disabled || checking}>
        <label>
          {tr('超时（秒）')}
          <input
            type="number"
            min="2"
            max="180"
            aria-label={tr('API 超时（秒）')}
            value={provider.timeoutSeconds}
            onChange={(e) =>
              patch({ timeoutSeconds: Math.max(2, Math.min(180, Number(e.target.value) || 15)) })
            }
          />
        </label>
        <label>
          {tr('自定义请求头（JSON）')}
          <textarea
            aria-label={tr('自定义请求头（JSON）')}
            value={provider.headers}
            maxLength={16384}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => patch({ headers: e.target.value })}
            placeholder={'{"X-API-Key":"…"}'}
          />
        </label>
        {provider.type === 'llm' && feature !== 'speech' && (
          <label className="provider-checkbox">
            <input
              type="checkbox"
              checked={provider.stream}
              onChange={(e) => patch({ stream: e.target.checked })}
            />
            {tr('流式返回文本')}
          </label>
        )}
        <div className="row">
          <button type="button" onClick={() => void save()}>
            {tr('保存 API 设置')}
          </button>
          <button type="button" onClick={forget}>
            {tr('清除当前后端凭据')}
          </button>
        </div>
      </fieldset>
      <div className="row">
        <button type="button" disabled={!ready || disabled || checking} onClick={() => void test()}>
          {tr('检查连接（不发送选区）')}
        </button>
        {checking && (
          <button
            type="button"
            onClick={() => {
              controller.current?.abort();
              setChecking(false);
            }}
          >
            {tr('取消')}
          </button>
        )}
      </div>
      <p className="provider-destination">{tr('发送至：{0}', destination(provider, feature))}</p>
      <p className="provider-transport">
        {usesDesktopRelay()
          ? tr('桌面直接连接接口，无需服务端开放跨域。')
          : tr('浏览器预览需要接口允许跨域请求。')}
      </p>
      <p className="provider-storage" role="status">
        {tr(names[storageStatus])}
      </p>
      {status && <p role="status">{status}</p>}
    </details>
  );
}
