import type { ProviderProfile, StorageStatus } from './providerSettings';
import { t } from './i18n';

export default function ChatApiSettings({
  provider,
  patch,
  ready,
  storageStatus,
  save,
  forget,
  disabled,
}: {
  provider: ProviderProfile;
  patch: (value: Partial<ProviderProfile>) => void;
  ready: boolean;
  storageStatus: StorageStatus;
  save: () => Promise<void>;
  forget: () => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="chat-api-settings" disabled={!ready || disabled}>
      <label>
        {t('API 地址')}
        <input
          aria-label={t('聊天 API 地址')}
          type="url"
          value={provider.url}
          placeholder="https://example.com/v1"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => patch({ url: e.target.value })}
        />
      </label>
      <label>
        {t('API 模型')}
        <input
          aria-label={t('聊天 API 模型')}
          value={provider.model}
          placeholder="model-id"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => patch({ model: e.target.value })}
        />
      </label>
      <label>
        API Key
        <input
          aria-label={t('聊天 API 密钥')}
          type="password"
          value={provider.key}
          placeholder={t('本地接口可留空')}
          autoComplete="new-password"
          onChange={(e) => patch({ key: e.target.value })}
        />
      </label>
      <details>
        <summary>{t('API 高级设置')}</summary>
        <label>
          {t('超时（秒）')}
          <input
            aria-label={t('聊天 API 超时（秒）')}
            type="number"
            min="2"
            max="180"
            value={provider.timeoutSeconds}
            onChange={(e) =>
              patch({ timeoutSeconds: Math.max(2, Math.min(180, Number(e.target.value) || 120)) })
            }
          />
        </label>
        <label>
          {t('自定义请求头（JSON）')}
          <textarea
            aria-label={t('聊天 API 请求头（JSON）')}
            value={provider.headers}
            autoComplete="off"
            spellCheck={false}
            maxLength={16384}
            rows={2}
            onChange={(e) => patch({ headers: e.target.value })}
          />
        </label>
        <label className="chat-api-checkbox">
          <input
            type="checkbox"
            checked={provider.stream}
            onChange={(e) => patch({ stream: e.target.checked })}
          />
          {t('流式返回文本')}
        </label>
        <label>
          {t('PDF 发送方式')}
          <select
            aria-label={t('PDF 发送方式')}
            value={provider.pdfInput ?? 'text'}
            onChange={(e) => patch({ pdfInput: e.target.value as 'text' | 'file' })}
          >
            <option value="text">{t('提取原 PDF 文字（兼容模式）')}</option>
            <option value="file">{t('原 PDF 文件（模型需支持）')}</option>
          </select>
        </label>
        <p>{t('图片与原 PDF 需要模型支持对应输入；文字模式有长度限制，不包含扫描图像。')}</p>
        <button type="button" onClick={forget}>
          {t('清除当前后端凭据')}
        </button>
      </details>
      <button type="button" onClick={() => void save()}>
        {t('保存 API 设置')}
      </button>
      <small role="status">
        {t(
          {
            loading: '正在读取后端配置…',
            pending: '正在保存后端配置…',
            encrypted: '密钥及请求头已加密保存在本机',
            session: '浏览器中的密钥、请求头和 URL 查询参数仅本次会话有效',
            error: '加密配置未能保存或读取；当前修改仅在本次会话有效',
          }[storageStatus],
        )}
      </small>
      <p>{t('使用所配置服务的 API 用量；与 ChatGPT 订阅额度独立。')}</p>
    </fieldset>
  );
}
