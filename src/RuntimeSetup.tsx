import { useEffect, useRef, useState } from 'react';
import { Download, Check } from 'lucide-react';
import { t, useLocale } from './i18n';
import type { RuntimeId, RuntimeProgress, RuntimeState } from './runtimeBridge';

const ids: RuntimeId[] = ['openvino', 'speech'];
const labels = { openvino: '公式、翻译、OCR 与朗读加速', speech: 'SenseVoice / Whisper 语音输入' };
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
  network: '下载失败，请检查网络后重试。',
  unsafe: '运行时目录不可用，请检查是否包含符号链接。',
  'disk-full': '磁盘空间不足。',
  unsupported: '自动安装目前仅支持 Windows x64。',
  setup: '运行时安装失败，请检查网络后重试。',
};

export default function RuntimeSetup() {
  useLocale();
  const bridge = window.surfaceDesktop?.runtimes;
  const [states, setStates] = useState<Partial<Record<RuntimeId, RuntimeState>>>({});
  const [busy, setBusy] = useState<RuntimeId | null>(null),
    [progress, setProgress] = useState<RuntimeProgress | null>(null),
    [message, setMessage] = useState('');
  const mounted = useRef(true),
    running = useRef<RuntimeId | null>(null);
  useEffect(() => {
    mounted.current = true;
    if (bridge)
      for (const id of ids)
        void bridge
          .run({ id, action: 'status' })
          .then((result) => {
            if (mounted.current && result.data)
              setStates((previous) => ({ ...previous, [id]: result.data }));
          })
          .catch(() => {});
    const off = bridge?.onProgress((value) => {
      if (mounted.current && running.current === value.id) setProgress(value);
    });
    return () => {
      mounted.current = false;
      off?.();
      if (running.current) void bridge?.run({ id: running.current, action: 'cancel' });
    };
  }, [bridge]);
  async function install(id: RuntimeId) {
    if (!bridge || running.current) return;
    running.current = id;
    setBusy(id);
    setMessage('');
    setProgress(null);
    try {
      const result = await bridge.run({ id, action: 'install' });
      if (mounted.current) {
        if (result.ok && result.data) setStates((previous) => ({ ...previous, [id]: result.data }));
        setMessage(
          result.ok
            ? t('运行时已准备就绪。')
            : t(runtimeErrors[result.error || 'setup'] || runtimeErrors.setup),
        );
      }
    } catch {
      if (mounted.current) setMessage(t(runtimeErrors.setup));
    } finally {
      running.current = null;
      if (mounted.current) {
        setBusy(null);
        setProgress(null);
      }
    }
  }
  return (
    <section className="runtime-setup" aria-label={t('自动安装本地运行时')}>
      <h3>{t('自动安装本地运行时')}</h3>
      <p className="model-note">
        {t('无需预装 Python。点击安装后自动准备独立环境，不修改系统 PATH；模型另行按需下载。')}
      </p>
      {ids.map((id) => (
        <div className="runtime-profile" key={id}>
          <div>
            <strong>{t(labels[id])}</strong>
            <small>
              {t(
                !bridge
                  ? '仅桌面应用可安装'
                  : !states[id]
                    ? '读取状态…'
                    : states[id]?.installed
                      ? '运行时已安装'
                      : '运行时未安装',
              )}
              {states[id]?.devices.length ? ' · ' + states[id]!.devices.join(' / ') : ''}
            </small>
          </div>
          <button
            disabled={!bridge || !!busy || !!states[id]?.installed}
            onClick={() => void install(id)}
          >
            {states[id]?.installed ? <Check size={15} /> : <Download size={15} />}{' '}
            {t(states[id]?.installed ? '已就绪' : '自动安装')}
          </button>
        </div>
      ))}
      {busy && (
        <div role="status">
          <span>{t(runtimeStages[progress?.stage || 'check'] || runtimeStages.check)}</span>
          {progress?.total ? <progress max={progress.total} value={progress.done} /> : <progress />}
          <button onClick={() => void bridge?.run({ id: busy, action: 'cancel' })}>
            {t('取消任务')}
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <p className="model-note">
        {t(
          '需联网访问 GitHub 和 PyPI，并预留数 GB 磁盘空间。GPU/NPU 驱动由 Windows 或设备厂商提供。',
        )}
      </p>
    </section>
  );
}
