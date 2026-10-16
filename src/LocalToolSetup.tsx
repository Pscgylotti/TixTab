import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { installRuntime, useRuntimeInstall } from './runtimeInstall';
import RuntimeInstallProgress from './RuntimeInstallProgress';
import type { LocalToolEngine } from './localDocumentTools';
import { localToolErrors, runLocalDocumentTool } from './localDocumentTools';
export default function LocalToolSetup({
  engine,
  onBusy,
  onCancel,
}: {
  engine: LocalToolEngine;
  onBusy: (busy: boolean) => void;
  onCancel?: (cancel: (() => void) | null) => void;
}) {
  const runtime = engine === 'uvdoc' ? 'openvino' : engine === 'homr' ? 'homr' : null;
  const state = useRuntimeInstall();
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [progress, setProgress] = useState(0);
  const owner = useRef<AbortController | null>(null),
    alive = useRef(true);
  useEffect(() => {
    onCancel?.(() => {
      if (!owner.current) return;
      owner.current.abort();
      void window.surfaceDesktop?.models?.cancel();
      if (runtime) void window.surfaceDesktop?.runtimes?.run({ id: runtime, action: 'cancel' });
    });
    return () => onCancel?.(null);
  }, [engine]);
  useEffect(() => {
    alive.current = true;
    const a = new AbortController();
    void (async () => {
      const b = window.surfaceDesktop;
      if (!b?.documentTools) return;
      const [r, models] = await Promise.all([
        b.documentTools.run({ action: 'status' }),
        b.models?.list(),
      ]);
      const available =
        engine === 'uvdoc'
          ? r.data?.document
          : engine === 'homr'
            ? r.data?.homr
            : r.data?.audiveris;
      if (!a.signal.aborted)
        setReady(!!available && !!models?.some((m) => m.id === engine && m.source !== 'missing'));
    })().catch(() => {});
    return () => {
      alive.current = false;
      a.abort();
      owner.current?.abort();
      if (owner.current) void window.surfaceDesktop?.models?.cancel();
    };
  }, [engine]);
  const prepare = async () => {
    if (owner.current) return;
    const a = new AbortController();
    owner.current = a;
    setBusy(true);
    onBusy(true);
    setProgress(0);
    setStatus(t('正在准备本地组件…'));
    const off = window.surfaceDesktop?.models?.onProgress((p) => {
      if (p.id === engine && !a.signal.aborted) setProgress(p.total ? p.done / p.total : 0);
    });
    try {
      const b = window.surfaceDesktop;
      if (!b?.documentTools || !b.models) throw Error('runtime-missing');
      if (runtime) {
        const r = await b.runtimes?.run({ id: runtime, action: 'status' });
        a.signal.throwIfAborted();
        if (!r?.data?.installed) {
          const r = await installRuntime(runtime);
          if (!r.ok) throw Error('runtime-missing');
        }
      }
      a.signal.throwIfAborted();
      setStatus(t('正在下载本地组件…'));
      if (!(await b.models.list()).some((m) => m.id === engine && m.source !== 'missing')) {
        const r = await b.models.run(engine, 'install');
        if (!r.ok) throw Error(r.error || 'missing-model');
      }
      a.signal.throwIfAborted();
      setStatus(t('正在配置本地组件…'));
      await runLocalDocumentTool({ action: 'prepare', engine }, a.signal);
      if (alive.current) {
        setReady(true);
        setStatus(t('本地组件已就绪。'));
      }
    } catch (e) {
      if (alive.current)
        setStatus(
          t(
            a.signal.aborted
              ? '已取消'
              : localToolErrors[(e as Error).message] || '组件准备失败，请检查下载源后重试。',
          ),
        );
    } finally {
      off?.();
      owner.current = null;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  return (
    <section className="local-tool-setup">
      <p>
        {t(
          engine === 'uvdoc'
            ? '复用 OpenVINO 环境，UVDoc 支持 CPU / GPU / NPU；处理结束后释放模型。'
            : engine === 'audiveris'
              ? 'Audiveris 使用随组件提供的 Java，按需运行，完成后退出。'
              : 'homr 使用本地 ONNX 模型，需要兼容的 Python 环境。',
        )}
      </p>
      <button
        disabled={ready || busy || !window.surfaceDesktop?.documentTools}
        onClick={() => void prepare()}
      >
        {t(
          ready
            ? '已就绪'
            : busy
              ? '正在准备…'
              : engine === 'uvdoc'
                ? '准备本地组件 · 30 MiB'
                : engine === 'audiveris'
                  ? '准备本地组件 · 81 MiB'
                  : '准备本地组件 · 134 MiB',
        )}
      </button>
      {busy && <progress value={progress} max={1} />}
      {status && <p role="status">{status}</p>}
      {runtime && state.active === runtime && <RuntimeInstallProgress id={runtime} />}
      {!window.surfaceDesktop?.documentTools && <p>{t('本地处理请使用桌面应用。')}</p>}
    </section>
  );
}
