import { useEffect, useState } from 'react';
import { t, useLocale } from './i18n';
import type { RuntimeId, RuntimeDiagnostics } from './runtimeBridge';
import { useRuntimeInstall, cancelRuntime } from './runtimeInstall';
import './runtimeInstall.css';
export const runtimeStages: Record<string, string> = {
  check: '检查现有环境…',
  download: '下载独立 Python…',
  extract: '解包 Python…',
  environment: '创建独立环境…',
  dependencies: '安装依赖，首次可能需要几分钟…',
  verify: '验证运行时与设备…',
};
export const runtimeErrors: Record<string, string> = {
  cancelled: '已取消',
  busy: '已有运行时安装任务，请稍候。',
  checksum: '下载校验失败，请重试。',
  network: '所有下载源均失败，请查看安装日志后重试。',
  unsafe: '运行时目录不可用，请检查是否包含符号链接。',
  'disk-full': '磁盘空间不足。',
  unsupported: '自动安装目前仅支持 Windows x64。',
  setup: '运行时安装失败，请查看日志后重试。',
};
export const sourceNames: Record<string, string> = {
  github: 'GitHub 官方源',
  npmmirror: 'npmmirror 镜像',
  pypi: 'PyPI 官方源',
  tuna: '清华镜像',
  ustc: '中科大镜像',
  custom: '自定义源',
};
export default function RuntimeInstallProgress({ id }: { id: RuntimeId }) {
  useLocale();
  const state = useRuntimeInstall(),
    [expanded, setExpanded] = useState(false),
    [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null),
    [now, setNow] = useState(Date.now());
  const active = state.active === id,
    progress = state.progress?.id === id ? state.progress : null;
  useEffect(() => {
    if (!expanded) return;
    let dead = false,
      reading = false;
    const update = async () => {
      setNow(Date.now());
      if (reading) return;
      reading = true;
      try {
        const result = await window.surfaceDesktop?.runtimes?.run({ id, action: 'diagnostics' });
        if (!dead && result?.diagnostics) setDiagnostics(result.diagnostics);
      } catch {
      } finally {
        reading = false;
      }
    };
    void update();
    const timer = active ? setInterval(() => void update(), 1500) : undefined;
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [expanded, active, id]);
  const seconds = diagnostics?.updatedAt
    ? Math.max(0, Math.floor((now - diagnostics.updatedAt) / 1000))
    : 0;
  return (
    <div className="runtime-install-progress">
      {active && (
        <>
          <div role="status">
            {t(runtimeStages[progress?.stage || 'check'] || runtimeStages.check)}
          </div>
          {progress?.source && (
            <small>{t('当前源：{0}', t(sourceNames[progress.source] || progress.source))}</small>
          )}
          {progress?.total ? <progress max={progress.total} value={progress.done} /> : <progress />}
          <button onClick={() => void cancelRuntime()}>{t('取消任务')}</button>
        </>
      )}
      <button
        className="runtime-log-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {t(expanded ? '收起安装日志' : '查看安装日志')}
      </button>
      {expanded && (
        <div className="runtime-log-panel">
          <small>
            {diagnostics?.updatedAt ? t('最后活动：{0} 秒前', seconds) : t('尚无安装日志。')}
          </small>
          {active && seconds >= 30 && (
            <p>{t('暂时没有新输出，可能正在下载或安装；可查看日志、等待或取消后重试。')}</p>
          )}
          <pre aria-label={t('安装日志')}>{diagnostics?.logs || t('尚无安装日志。')}</pre>
        </div>
      )}
    </div>
  );
}
