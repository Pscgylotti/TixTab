import { useEffect, useRef, useState } from 'react';
import { Download, Check } from 'lucide-react';
import { t, useLocale } from './i18n';
import type { RuntimeId, RuntimeState } from './runtimeBridge';
import { useRuntimeInstall, installRuntime } from './runtimeInstall';
import RuntimeInstallProgress, { runtimeErrors } from './RuntimeInstallProgress';
import RuntimeDownloadSettings from './RuntimeDownloadSettings';
export { runtimeErrors, runtimeStages } from './RuntimeInstallProgress';

const ids: RuntimeId[] = ['openvino', 'speech', 'pdf', 'homr', 'copista', 'matchmaker'];
const labels = {
  openvino: '公式、翻译、OCR、文档矫正与朗读加速',
  speech: 'SenseVoice / Whisper 语音输入',
  pdf: 'PDF 原生元素编辑',
  homr: 'homr 五线谱识别',
  copista: 'Copista 28M 五线谱识别（复用 homr 环境）',
  matchmaker: 'Matchmaker 实时跟谱（复用 homr 环境）',
};

export default function RuntimeSetup() {
  useLocale();
  const bridge = window.surfaceDesktop?.runtimes;
  const [states, setStates] = useState<Partial<Record<RuntimeId, RuntimeState>>>({});
  const state = useRuntimeInstall(),
    busy = state.active;
  const mounted = useRef(true);
  const message = state.result
    ? t(
        state.result.ok
          ? '运行时已准备就绪。'
          : runtimeErrors[state.result.error || 'setup'] || runtimeErrors.setup,
      )
    : '';
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
    return () => {
      mounted.current = false;
    };
  }, [bridge]);
  useEffect(() => {
    const r = state.result;
    if (r?.ok && r.data) setStates((previous) => ({ ...previous, [r.id]: r.data! }));
  }, [state.result]);
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
            onClick={() => void installRuntime(id)}
          >
            {states[id]?.installed ? <Check size={15} /> : <Download size={15} />}{' '}
            {t(states[id]?.installed ? '已就绪' : '自动安装')}
          </button>
        </div>
      ))}
      <RuntimeInstallProgress id={busy || state.result?.id || 'pdf'} />
      <RuntimeDownloadSettings />
      {message && <p role="status">{message}</p>}
      <p className="model-note">
        {t('下载失败会依次尝试国内镜像。请预留足够磁盘空间；GPU/NPU 驱动由系统或设备厂商提供。')}
      </p>
    </section>
  );
}
