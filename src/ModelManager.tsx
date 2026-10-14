import { useEffect, useRef, useState } from 'react';
import { X, Download, ShieldCheck, Trash2 } from 'lucide-react';
import catalog from '../electron/model-catalog.json';
import { t, useLocale } from './i18n';
import type { ModelAction, ModelProgress, ModelState } from './modelLibrary';
import './modelLibrary.css';
import RuntimeSetup from './RuntimeSetup';
import ModelConfirmation from './ModelConfirmation';
import { useRuntimeClose } from './useRuntimeClose';
const size = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const features = {
  formula: '公式',
  translation: '翻译',
  ocr: '文字 OCR',
  speech: '朗读',
  dictation: '语音输入',
};
const errors: Record<string, string> = {
  cancelled: '已取消',
  checksum: '模型校验失败，未启用下载文件。',
  busy: '已有模型管理任务正在运行。',
  'disk-full': '磁盘空间不足。',
  unsafe: '模型目录不可用，请检查是否包含符号链接。',
  failed: '模型操作失败，请检查网络与磁盘后重试。',
};
export default function ModelManager({ onClose }: { onClose: () => void }) {
  useLocale();
  const bridge = window.surfaceDesktop?.models;
  const { close, confirmation } = useRuntimeClose(onClose);
  const [states, setStates] = useState<ModelState[]>([]),
    [progress, setProgress] = useState<ModelProgress | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState<{ id: string; action: ModelAction } | null>(null);
  const mounted = useRef(true),
    running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (bridge) {
      void bridge
        .list()
        .then((data) => {
          if (mounted.current) setStates(data);
        })
        .catch(() => {
          if (mounted.current) setMessage(t('无法读取模型状态。'));
        });
    }
    const off = bridge?.onProgress((value) => {
      if (mounted.current) setProgress(value);
    });
    return () => {
      mounted.current = false;
      off?.();
      if (running.current) void bridge?.cancel();
    };
  }, [bridge]);
  async function run(id: string, action: ModelAction) {
    if (!bridge || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    setPending(null);
    setProgress(null);
    try {
      const result = await bridge.run(id, action);
      if (mounted.current) {
        setMessage(
          t(result.ok ? '模型操作已完成。' : errors[result.error || 'failed'] || errors.failed),
        );
        setStates(await bridge.list());
      }
    } catch {
      if (mounted.current) setMessage(t(errors.failed));
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  const chosen = pending && catalog.models.find((m) => m.id === pending.id);
  return (
    <div className="modal-scrim">
      <section
        className="modal model-manager"
        role="dialog"
        aria-modal="true"
        aria-label={t('本地模型管理')}
        inert={!!pending}
      >
        <header>
          <div>
            <h2>{t('本地模型管理')}</h2>
            <p>{t('按需下载，离线运行')}</p>
          </div>
          <button className="icon-button" aria-label={t('关闭模型管理')} onClick={close}>
            <X size={20} />
          </button>
        </header>
        <div className="model-manager-body">
          <RuntimeSetup />
          <p className="model-note">
            {t('下载仅在确认后开始。打开此页不会加载模型；校验由你手动启动，避免后台耗电。')}
          </p>
          {!bridge && (
            <p className="model-note">
              {t('浏览器预览仅展示模型清单；下载与删除请使用桌面应用。')}
            </p>
          )}
          <p className="model-note">
            {t('AUTO 优先 NPU，再尝试 GPU 和 CPU；需要可选 OpenVINO 运行时。不兼容时回退 CPU。')}
          </p>
          {message && (
            <p role="status" className="model-message">
              {message}
            </p>
          )}
          {progress && (
            <div className="model-progress" role="status">
              <span>
                {t(
                  progress.action === 'verify'
                    ? '正在校验…'
                    : progress.action === 'remove'
                      ? '正在删除…'
                      : '正在下载…',
                )}{' '}
                {size(progress.done)} / {size(progress.total)}
              </span>
              <progress max={progress.total} value={progress.done} />
              <button disabled={!busy} onClick={() => void bridge?.cancel()}>
                {t('取消任务')}
              </button>
            </div>
          )}
          <div className="model-list">
            {catalog.models.map((m) => {
              const state = states.find((s) => s.id === m.id);
              return (
                <article className="model-card" key={m.id} data-model-id={m.id}>
                  <div className="model-card-title">
                    <h3>{m.name}</h3>
                    <span>{t(features[m.feature as keyof typeof features])}</span>
                  </div>
                  <div className="model-summary">
                    <strong>{size(m.bytes)}</strong>
                    <span>
                      {t(
                        !bridge
                          ? '预览'
                          : !state
                            ? '读取状态…'
                            : state.source === 'missing'
                              ? '未安装'
                              : state.source === 'downloaded'
                                ? '已下载 · 离线可用'
                                : '内置 · 离线可用',
                      )}
                    </span>
                    {state?.verified && <span>{t('SHA256 已校验')}</span>}
                  </div>
                  <p className="model-note">
                    {m.id.startsWith('unimumer')
                      ? t('Uni-MuMER 为按需下载的实验后端，不包含在离线包中。') +
                        ' ' +
                        t(
                          'Uni-MuMER 使用 GPU 或 CPU；不支持 NPU。请先在本地模型管理中下载模型及运行时。',
                        )
                      : m.id.startsWith('piper-') && m.id !== 'piper-runtime'
                        ? t('朗读需同时安装 Piper phonemizer；完整离线包已内置。')
                        : t('模型仅在使用对应功能时加载。')}
                  </p>
                  <div className="model-actions">
                    <button
                      disabled={
                        !bridge || busy || !state || state.source === 'downloaded' || state.bundled
                      }
                      onClick={() => setPending({ id: m.id, action: 'install' })}
                    >
                      <Download size={16} />
                      {t('下载')}
                    </button>
                    <button
                      disabled={!bridge || busy || !state || state.source === 'missing'}
                      onClick={() => void run(m.id, 'verify')}
                    >
                      <ShieldCheck size={16} />
                      {t('校验文件')}
                    </button>
                    <button
                      disabled={!bridge || busy || !state?.downloaded}
                      onClick={() => setPending({ id: m.id, action: 'remove' })}
                    >
                      <Trash2 size={16} />
                      {t('删除下载副本')}
                    </button>
                  </div>
                  <details>
                    <summary>{t('版本、许可与文件')}</summary>
                    <dl>
                      <dt>{t('固定版本')}</dt>
                      <dd>{m.revision}</dd>
                      <dt>{t('许可说明')}</dt>
                      <dd>{m.license}</dd>
                      <dt>{t('运行设备')}</dt>
                      <dd>{m.device}</dd>
                      <dt>{t('模型来源')}</dt>
                      <dd>
                        <a href={m.source} target="_blank" rel="noreferrer">
                          {m.source}
                        </a>
                      </dd>
                    </dl>
                    {m.files.map((f) => (
                      <div className="model-file" key={f.path}>
                        <span>
                          {f.path} · {size(f.bytes)}
                        </span>
                        <code>{f.sha256}</code>
                      </div>
                    ))}
                    {m.id.startsWith('piper-') && m.id !== 'piper-runtime' && (
                      <p className="model-note">
                        {t(
                          '声音模型与训练数据条款以原始 MODEL_CARD 为准；Huayan 数据许可标注为 Unknown。',
                        )}
                      </p>
                    )}
                  </details>
                </article>
              );
            })}
          </div>
          <p className="model-note">
            {t(
              '内置权重属于完整离线包，不能在应用中删除。轻量包只下载选定模型；旧版原生编译缓存不在这里删除。',
            )}
          </p>
        </div>
      </section>
      {chosen && pending && (
        <ModelConfirmation
          model={chosen}
          remove={pending.action === 'remove'}
          onCancel={() => setPending(null)}
          onConfirm={() => void run(pending.id, pending.action)}
        />
      )}
      {confirmation}
    </div>
  );
}
