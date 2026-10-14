import { useEffect, useState } from 'react';
import { t, useLocale } from './i18n';
import type { RuntimeSources } from './runtimeBridge';
import { useRuntimeInstall } from './runtimeInstall';
import './runtimeInstall.css';
export default function RuntimeDownloadSettings() {
  useLocale();
  const bridge = window.surfaceDesktop?.runtimes,
    { active } = useRuntimeInstall();
  const [sources, setSources] = useState<RuntimeSources>({
    packages: 'auto',
    python: 'auto',
    customIndex: '',
  });
  const [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    void bridge
      ?.run({ id: 'pdf', action: 'sources' })
      .then((r) => {
        if (alive) {
          if (r.sources) setSources(r.sources);
          setReady(true);
        }
      })
      .catch(() => {
        if (alive) setMessage('读取下载源失败，请重新打开面板。');
      });
    return () => {
      alive = false;
    };
  }, [bridge]);
  const disabled = !bridge || !ready || !!active || saving;
  return (
    <details className="runtime-download-settings">
      <summary>{t('下载源设置')}</summary>
      <label>
        {t('Python 包优先下载源')}
        <select
          disabled={disabled}
          value={sources.packages}
          onChange={(e) => {
            setMessage('');
            setSources({ ...sources, packages: e.target.value as RuntimeSources['packages'] });
          }}
        >
          <option value="auto">{t('自动（官方源优先）')}</option>
          <option value="tuna">{t('清华镜像')}</option>
          <option value="ustc">{t('中科大镜像')}</option>
          <option value="pypi">PyPI</option>
          <option value="custom">{t('自定义 HTTPS 源')}</option>
        </select>
      </label>
      {sources.packages === 'custom' && (
        <label>
          {t('自定义包索引地址')}
          <input
            type="url"
            disabled={disabled}
            value={sources.customIndex}
            maxLength={2048}
            placeholder="https://example.org/simple"
            onChange={(e) => setSources({ ...sources, customIndex: e.target.value })}
          />
        </label>
      )}
      <label>
        {t('Python 本体优先下载源')}
        <select
          disabled={disabled}
          value={sources.python}
          onChange={(e) => {
            setMessage('');
            setSources({ ...sources, python: e.target.value as RuntimeSources['python'] });
          }}
        >
          <option value="auto">{t('自动（官方源优先）')}</option>
          <option value="github">{t('GitHub 官方源')}</option>
          <option value="npmmirror">npmmirror</option>
        </select>
      </label>
      <p>
        {t(
          '优先使用所选源，失败后依次尝试备用源。自定义地址必须使用 HTTPS，且不含登录信息、查询参数或片段。保存后用于后续安装。',
        )}
      </p>
      <button
        disabled={disabled}
        onClick={async () => {
          setSaving(true);
          setMessage('');
          try {
            const r = await bridge!.run({ id: 'pdf', action: 'configure-sources', sources });
            setMessage(
              r.ok
                ? '下载源已保存。'
                : r.error === 'busy'
                  ? '已有运行时安装任务，请稍候。'
                  : '下载源无效或保存失败，请检查地址。',
            );
          } catch {
            setMessage('下载源无效或保存失败，请检查地址。');
          } finally {
            setSaving(false);
          }
        }}
      >
        {t('保存下载源')}
      </button>
      {message && <p role="status">{t(message)}</p>}
    </details>
  );
}
