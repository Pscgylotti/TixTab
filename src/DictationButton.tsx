import { useEffect, useRef, useState } from 'react';
import { Mic, Square, SlidersHorizontal, X, Download } from 'lucide-react';
import { t, useLocale } from './i18n';
import type { ModelState } from './modelLibrary';
import { runtimeStages, runtimeErrors } from './RuntimeSetup';
import type { RuntimeProgress } from './runtimeBridge';
const engines = ['sensevoice-small', 'whisper-small', 'system'] as const;
// Chat and floating keyboards share one native recorder, including portal windows.
const recorders = new WeakMap<object, symbol>();
type Engine = (typeof engines)[number];
const names: Record<Engine, string> = {
  'sensevoice-small': 'SenseVoiceSmall INT8',
  'whisper-small': 'Whisper small INT8',
  system: 'Windows',
};
function saved(key: string, fallback: string) {
  try {
    return localStorage.getItem('surfacetab.chat.' + key) || fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem('surfacetab.chat.' + key, value);
  } catch {}
}
const errors: Record<string, string> = {
  language: '请在 Windows 设置中安装当前语言的语音识别包。',
  microphone: '无法启动麦克风，请检查 Windows 麦克风权限与输入设备。',
  'model-missing': '请打开语音设置，下载所选语音模型。',
  runtime: '请打开语音设置，安装本地语音运行时。',
  device: '当前设备无法运行 Whisper，请在语音设置中切换到 CPU。',
  inference: '语音识别失败，请重试或切换引擎。',
  overload: '识别未跟上录音速度，请停止后重试，或切换到 SenseVoiceSmall。',
  timeout: '语音识别超时，请重试或切换到 CPU。',
  busy: '语音引擎正在处理上一项任务，请稍候。',
  setup: '运行时安装失败，请检查网络后重试。',
};
export default function DictationButton({
  disabled,
  onText,
  onStatus,
  onModels,
  hostDocument = document,
}: {
  disabled: boolean;
  onText: (text: string) => void;
  onStatus: (text: string) => void;
  onModels?: () => void;
  hostDocument?: Document;
}) {
  const locale = useLocale(),
    [language, setLanguage] = useState<'zh-CN' | 'en-US'>(() =>
      saved('voiceLanguage', locale === 'en' ? 'en-US' : 'zh-CN') === 'en-US' ? 'en-US' : 'zh-CN',
    );
  const [engine, setEngine] = useState<Engine>(() => {
    const value = saved('voiceEngine', 'sensevoice-small');
    return engines.includes(value as Engine) ? (value as Engine) : 'sensevoice-small';
  });
  const [device, setDevice] = useState(() => {
    const value = saved('voiceDevice', 'AUTO');
    return ['AUTO', 'CPU', 'GPU', 'NPU'].includes(value) ? value : 'AUTO';
  });
  const [open, setOpen] = useState(false),
    [listening, setListening] = useState(false),
    [finishing, setFinishing] = useState(false),
    [levels, setLevels] = useState<number[]>(Array(20).fill(0));
  const [runtime, setRuntime] = useState<{ installed: boolean; devices: string[] } | null>(null),
    [states, setStates] = useState<ModelState[]>([]),
    [settingBusy, setSettingBusy] = useState(''),
    [message, setMessage] = useState(''),
    [download, setDownload] = useState(0);
  const running = useRef(false),
    generation = useRef(0),
    mounted = useRef(true),
    activePromise = useRef<Promise<void> | null>(null),
    stopping = useRef(false),
    busyRef = useRef('');
  const textCallback = useRef(onText),
    statusCallback = useRef(onStatus);
  textCallback.current = onText;
  statusCallback.current = onStatus;
  const bridge = window.surfaceDesktop?.dictation,
    models = window.surfaceDesktop?.models;
  const recorder = useRef(Symbol('dictation'));
  const release = () => {
    if (bridge && recorders.get(bridge) === recorder.current) recorders.delete(bridge);
  };
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null);
  useEffect(
    () =>
      window.surfaceDesktop?.runtimes?.onProgress((value) => {
        if (value.id === 'speech' && mounted.current) setRuntimeProgress(value);
      }),
    [],
  );
  const cancel = () => {
    if (!running.current) return;
    generation.current++;
    running.current = false;
    stopping.current = false;
    setListening(false);
    setFinishing(false);
    statusCallback.current('');
    void bridge?.run({ action: 'cancel' });
    release();
  };
  const stop = () => {
    if (!running.current || stopping.current) return;
    stopping.current = true;
    setListening(false);
    setFinishing(true);
    statusCallback.current(t('正在识别最后一句…'));
    void bridge?.run({ action: 'stop' });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (running.current) void bridge?.run({ action: 'cancel' });
      running.current = false;
      release();
      if (busyRef.current === 'setup') void bridge?.run({ action: 'cancel-setup' });
      if (busyRef.current === 'download') void models?.cancel();
    };
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (hostDocument.hidden) cancel();
    };
    hostDocument.addEventListener('visibilitychange', hidden);
    return () => hostDocument.removeEventListener('visibilitychange', hidden);
  }, [hostDocument]);
  useEffect(() => {
    if (disabled && running.current) cancel();
  }, [disabled]);
  const refresh = async () => {
    try {
      const [r, s] = await Promise.all([bridge?.run({ action: 'status' }), models?.list()]);
      if (mounted.current) {
        setRuntime(r?.ok && typeof r.data?.installed === 'boolean' ? r.data : null);
        setStates(s || []);
      }
    } catch {
      if (mounted.current) setMessage(t('无法读取语音引擎状态。'));
    }
  };
  useEffect(() => {
    if (open) void refresh();
  }, [open]);
  useEffect(
    () =>
      models?.onProgress((p) => {
        if (p.id === engine && mounted.current) setDownload(p.total ? p.done / p.total : 0);
      }),
    [models, engine],
  );
  const start = async (selected = language) => {
    if (running.current || !bridge) return;
    if (recorders.has(bridge)) {
      statusCallback.current(t(errors.busy));
      return;
    }
    recorders.set(bridge, recorder.current);
    running.current = true;
    stopping.current = false;
    setListening(true);
    setFinishing(false);
    setLevels(Array(20).fill(0));
    const token = ++generation.current;
    statusCallback.current(t('正在加载语音模型，首次运行可能需要较长时间…'));
    try {
      const started = await bridge.run({ action: 'start', language: selected, engine, device });
      if (!started.ok) throw new Error(started.error);
      if (token !== generation.current) return;
      while (token === generation.current) {
        const next = await bridge.run({ action: 'read', id: started.data.id });
        if (token !== generation.current) return;
        if (!next.ok) throw new Error(next.error);
        if (next.data.text) textCallback.current(next.data.text);
        if (next.data.error) throw new Error(next.data.error);
        const level = Number(next.data.level) || 0;
        setLevels((old) => [...old.slice(1), Math.max(0, Math.min(100, level))]);
        const suffix = next.data.device
          ? ' · ' + next.data.device + (next.data.fallback ? ' ' + t('已回退') : '')
          : '';
        statusCallback.current(
          t(
            stopping.current
              ? '正在识别最后一句…'
              : next.data.processing
                ? '正在离线识别…'
                : next.data.ready
                  ? '正在离线听写，点击麦克风停止。'
                  : '正在加载语音模型，首次运行可能需要较长时间…',
          ) + suffix,
        );
        if (next.data.done) break;
      }
      statusCallback.current('');
    } catch (e) {
      if (token === generation.current) {
        const key = e instanceof Error ? e.message : '';
        statusCallback.current(t(errors[key] || errors.inference));
        if (['runtime', 'model-missing'].includes(key)) setOpen(true);
        if (key !== 'busy') void bridge.run({ action: 'cancel' });
      }
    } finally {
      if (token === generation.current) {
        running.current = false;
        release();
        stopping.current = false;
        setListening(false);
        setFinishing(false);
      }
    }
  };
  const begin = (selected = language) => {
    activePromise.current = start(selected);
  };
  const changeLanguage = async (selected: 'zh-CN' | 'en-US') => {
    const resume = running.current;
    if (resume) stop();
    setLanguage(selected);
    save('voiceLanguage', selected);
    if (resume) {
      await activePromise.current;
      if (mounted.current && !disabled) begin(selected);
    }
  };
  const prepare = async (kind: 'setup' | 'download') => {
    if (settingBusy || running.current) return;
    busyRef.current = kind;
    setSettingBusy(kind);
    setMessage('');
    setDownload(0);
    try {
      setRuntimeProgress(null);
      const result =
        kind === 'setup'
          ? await bridge?.run({ action: 'setup' })
          : await models?.run(engine, 'install');
      if (mounted.current) {
        setMessage(
          t(
            result?.ok
              ? '语音引擎已准备就绪。'
              : kind === 'setup'
                ? runtimeErrors[result?.error || 'setup'] || runtimeErrors.setup
                : '模型下载失败，请检查网络后重试。',
          ),
        );
        await refresh();
      }
    } catch {
      if (mounted.current)
        setMessage(t(kind === 'setup' ? errors.setup : '模型下载失败，请检查网络后重试。'));
    } finally {
      busyRef.current = '';
      if (mounted.current) setSettingBusy('');
    }
  };
  const installed = states.some((s) => s.id === engine && s.source !== 'missing');
  return (
    <div className="chat-voice-controls">
      <button
        className={`icon-button chat-dictation ${listening ? 'listening' : ''}`}
        aria-label={t(listening ? '停止语音输入' : '语音输入')}
        aria-pressed={listening}
        title={names[engine] + ' · ' + t('本地识别；识别文字可编辑，点击发送后才提交。')}
        disabled={disabled || finishing || !!settingBusy || !bridge}
        onClick={() => (listening ? stop() : begin())}
      >
        {listening ? <Square size={15} /> : <Mic size={16} />}
      </button>
      <select
        className="chat-voice-language"
        aria-label={t('语音输入语言')}
        value={language}
        disabled={disabled || finishing}
        onChange={(e) => void changeLanguage(e.target.value as 'zh-CN' | 'en-US')}
      >
        <option value="zh-CN">中文</option>
        <option value="en-US">EN</option>
      </select>
      <button
        className="icon-button chat-voice-settings-button"
        aria-label={t('语音设置')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={14} />
      </button>
      {listening && (
        <div
          className="chat-voice-wave"
          role="img"
          aria-label={t('麦克风音量波形')}
          title={t('实际麦克风音量')}
          data-level={levels.at(-1)}
        >
          {levels.map((level, i) => (
            <i key={i} style={{ height: `${2 + Math.sqrt(level / 100) * 20}px` }} />
          ))}
        </div>
      )}
      {open && (
        <section className="chat-voice-settings" role="dialog" aria-label={t('本地语音输入')}>
          <header>
            <strong>{t('本地语音输入')}</strong>
            <button
              className="icon-button"
              aria-label={t('关闭语音设置')}
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </header>
          <label>
            {t('识别引擎')}
            <select
              aria-label={t('识别引擎')}
              value={engine}
              disabled={listening || finishing || !!settingBusy}
              onChange={(e) => {
                const next = e.target.value as Engine;
                setEngine(next);
                save('voiceEngine', next);
                setMessage('');
              }}
            >
              {engines.map((e) => (
                <option key={e} value={e}>
                  {names[e]}
                </option>
              ))}
            </select>
          </label>
          {engine === 'whisper-small' && (
            <label>
              {t('推理设备')}
              <select
                aria-label={t('语音推理设备')}
                value={device}
                disabled={listening || finishing || !!settingBusy}
                onChange={(e) => {
                  setDevice(e.target.value);
                  save('voiceDevice', e.target.value);
                }}
              >
                <option value="AUTO">AUTO · NPU → GPU → CPU</option>
                {['NPU', 'GPU', 'CPU'].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
          )}
          <p>
            {t(
              engine === 'sensevoice-small'
                ? '轻量中文优先，CPU 双线程；模型约 228 MiB。'
                : engine === 'whisper-small'
                  ? '多语言识别，模型约 245 MiB。首次 NPU/GPU 编译会较慢。'
                  : '使用 Windows 已安装的离线语音识别包。',
            )}
          </p>
          {engine !== 'system' && (
            <>
              <div className="chat-voice-readiness">
                <span>{t(installed ? '模型已安装' : '模型未安装')}</span>
                <span>{t(runtime?.installed ? '运行时已安装' : '运行时未安装')}</span>
              </div>
              {runtime?.devices?.length ? (
                <p>
                  {t('可用设备')}: {runtime.devices.join(' · ')}
                </p>
              ) : null}
              {!installed && (
                <button
                  disabled={!models || !!settingBusy || listening || finishing}
                  onClick={() => void prepare('download')}
                >
                  <Download size={14} />
                  {t('下载模型')} · {engine === 'sensevoice-small' ? '228' : '245'} MiB
                </button>
              )}
              {!runtime?.installed && (
                <button
                  disabled={!bridge || !!settingBusy || listening || finishing}
                  onClick={() => void prepare('setup')}
                >
                  {t('安装本地语音运行时')}
                </button>
              )}
              <p className="chat-voice-note">
                {t('自动下载独立 Python 与语音依赖，不更改公式/OCR 环境。录音不上传、不保存。')}
              </p>
            </>
          )}
          {settingBusy && (
            <div role="status">
              {t(
                settingBusy === 'setup'
                  ? runtimeStages[runtimeProgress?.stage || 'check'] || runtimeStages.check
                  : '正在下载…',
              )}
              {settingBusy === 'download' ? (
                <progress max={1} value={download} />
              ) : runtimeProgress?.total ? (
                <progress max={runtimeProgress.total} value={runtimeProgress.done} />
              ) : (
                <progress />
              )}
              <button
                onClick={() => {
                  if (settingBusy === 'setup') void bridge?.run({ action: 'cancel-setup' });
                  else void models?.cancel();
                }}
              >
                {t('取消任务')}
              </button>
            </div>
          )}
          {message && <p role="status">{message}</p>}
          {onModels && (
            <button
              disabled={!!settingBusy}
              onClick={() => {
                setOpen(false);
                onModels();
              }}
            >
              {t('本地模型管理')}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
