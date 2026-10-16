import { getModelIdleSeconds } from './modelIdle';
import { useEffect, useRef, useState } from 'react';
import { Mic, Square, SlidersHorizontal, X, Download } from 'lucide-react';
import { t, useLocale } from './i18n';
import type { ModelState } from './modelLibrary';
import { runtimeStages, runtimeErrors } from './RuntimeSetup';
import type { RuntimeProgress } from './runtimeBridge';
import { backgroundTasks } from './backgroundTasks';
const engines = [
  'sensevoice-small',
  'whisper-small',
  'system',
  'windows-ai',
  'windows-sdk',
] as const;
// Chat and floating keyboards share one native recorder, including portal windows.
const recorders = new WeakMap<object, symbol>();
type Engine = (typeof engines)[number];
const names: Record<Engine, string> = {
  'sensevoice-small': 'SenseVoiceSmall INT8',
  'whisper-small': 'Whisper small INT8',
  system: 'Windows',
  'windows-ai': 'Windows AI Speech（本地，实验性）',
  'windows-sdk': 'Windows SDK Speech（可能联网）',
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
  'microphone-missing': '所选麦克风不可用，请重新连接设备或在语音设置中选择其他麦克风。',
  'model-missing': '请打开语音设置，下载所选语音模型。',
  runtime: '请打开语音设置，安装本地语音运行时。',
  device: '当前设备无法运行 Whisper，请在语音设置中切换到 CPU。',
  inference: '语音识别失败，请重试或切换引擎。',
  overload: '识别未跟上录音速度，请停止后重试，或切换到 SenseVoiceSmall。',
  timeout: '语音识别超时，请重试或切换到 CPU。',
  'windows-speech-timeout': 'Windows 语音响应超时，请重试或切换其它语音引擎。',
  'windows-speech-model-timeout':
    'Windows 系统语音模型加载超时，尚未开始录音。请重试，或暂时切换其它语音引擎。',
  'windows-speech-model-failed':
    'Windows 系统语音模型加载失败，尚未开始录音。请检查系统 AI 组件与 NPU 驱动，或切换其它语音引擎。',
  'windows-speech-provider-timeout':
    'Windows ML 推理组件初始化超时，请检查系统 AI 组件与 NPU 驱动，或切换其它语音引擎。',
  'windows-speech-microphone-timeout': 'Windows 麦克风启动超时，请检查输入设备与麦克风权限。',
  busy: '语音引擎正在处理上一项任务，请稍候。',
  setup: '运行时安装失败，请检查网络后重试。',
  'windows-ai-unavailable': 'Windows AI 语音不可用，请检查系统版本、系统模型和组件身份。',
  'windows-ai-identity':
    'Windows 语音组件缺少身份或麦克风权限，请注册组件并检查 Windows 隐私设置。',
  'windows-ai-registration-failed': '组件注册失败，请检查签名或现有开发者模式设置。',
  'model-not-ready': 'Windows 语音模型尚未就绪，请在语音设置中准备系统模型。',
  'windows-ai-model-prepare': 'Windows 系统语音模型准备失败。',
  'windows-ai-state-DisabledByUser': '系统语音模型已被禁用，请在 Windows 设置的 AI 组件中启用。',
  'windows-ai-state-CapabilityMissing': '语音组件缺少系统 AI 权限，请重新注册组件权限。',
  'windows-ai-state-OSUpdateNeeded': '此语音模型需要更新 Windows 后才能使用。',
  'windows-ai-state-NotCompatibleWithSystemHardware':
    '当前硬件或驱动不兼容 Windows AI 语音，请使用其它语音引擎。',
  'windows-ai-state-NotSupportedOnCurrentSystem':
    '当前系统不支持 Windows AI 语音，请使用其它语音引擎。',
  'speech-privacy': 'Windows SDK 听写未就绪，请检查在线语音识别与麦克风隐私设置。',
};
export default function DictationButton({
  disabled,
  onText,
  onStatus,
  onModels,
  hostDocument = document,
  toggleRequest = 0,
  sendRequest = 0,
  onShortcutFinished,
}: {
  disabled: boolean;
  onText: (text: string) => void;
  onStatus: (text: string) => void;
  onModels?: () => void;
  hostDocument?: Document;
  toggleRequest?: number;
  sendRequest?: number;
  onShortcutFinished?: () => void;
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
  const [microphone, setMicrophone] = useState(() => saved('voiceMicrophone', ''));
  const [microphones, setMicrophones] = useState<
      { id: string; name: string; isDefault?: boolean }[]
    >([]),
    [defaultInput, setDefaultInput] = useState(''),
    [microphonesBusy, setMicrophonesBusy] = useState(false),
    [microphoneError, setMicrophoneError] = useState(''),
    [activeInput, setActiveInput] = useState('');
  const inputRequest = useRef(0);
  const [runtime, setRuntime] = useState<{ installed: boolean; devices: string[] } | null>(null),
    [states, setStates] = useState<ModelState[]>([]),
    [settingBusy, setSettingBusy] = useState(''),
    [message, setMessage] = useState(''),
    [download, setDownload] = useState(0);
  const running = useRef(false),
    starting = useRef(false),
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
  const shortcut = useRef({ seen: 0, sendSeen: 0, send: false, heard: false });
  const shortcutFinished = useRef(onShortcutFinished);
  const windowsPreparation = useRef<string | null>(null);
  const [windowsProgress, setWindowsProgress] = useState<{ stage: string; value: number } | null>(
    null,
  );
  shortcutFinished.current = onShortcutFinished;
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
    shortcut.current.send = false;
    running.current = false;
    starting.current = false;
    stopping.current = false;
    setListening(false);
    setFinishing(false);
    statusCallback.current('');
    void bridge?.run({ action: 'cancel' });
    release();
  };
  const stop = () => {
    if (!running.current || stopping.current) return;
    if (starting.current && ['windows-ai', 'windows-sdk'].includes(engine)) {
      cancel();
      return;
    }
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
      if (busyRef.current === 'windows') void bridge?.run({ action: 'windows-cancel' });
      if (windowsPreparation.current)
        backgroundTasks.finish(windowsPreparation.current, t('已取消'));
    };
  }, []);
  useEffect(
    () =>
      bridge?.onProgress?.((progress) => {
        if (running.current && starting.current) {
          const stages: Record<string, string> = {
            readiness: '正在检查系统语音模型…',
            'provider-register': '正在初始化 Windows ML 推理组件…',
            'microphone-select': '正在选择麦克风…',
            'model-loading': '正在加载系统语音模型，首次加载可能需要数分钟…',
            'model-ready': '系统语音模型已加载…',
            'recognizer-create': '正在创建语音识别器…',
            'microphone-start': '正在启动麦克风…',
            listening: '正在离线听写，点击麦克风停止。',
          };
          if (stages[progress.stage])
            statusCallback.current(
              t(stages[progress.stage]) +
                (progress.stage === 'model-loading' ? ` ${Math.round(progress.value * 100)}%` : ''),
            );
        }
        if (!windowsPreparation.current) return;
        const stages: Record<string, string> = {
          Installing: '正在下载系统语音模型…',
          Caching: '正在准备系统语音模型…',
          Loading: '正在加载系统语音模型…',
        };
        const text = t(stages[progress.stage] || '正在准备系统语音模型…');
        if (mounted.current) {
          setWindowsProgress(progress);
          setMessage(text + ` ${Math.round(progress.value * 100)}%`);
        }
        backgroundTasks.update(windowsPreparation.current, {
          status: text,
          done: progress.value,
          total: 1,
        });
      }),
    [bridge],
  );
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
  const refreshMicrophones = async () => {
    const request = ++inputRequest.current;
    setMicrophonesBusy(true);
    setMicrophoneError('');
    try {
      const result = await bridge?.run({ action: 'microphones' });
      if (!mounted.current || request !== inputRequest.current) return;
      if (!result?.ok || !Array.isArray(result.data?.microphones)) throw Error('microphone');
      setMicrophones(result.data.microphones);
      setDefaultInput(result.data.defaultId || '');
    } catch {
      if (mounted.current && request === inputRequest.current)
        setMicrophoneError(t('无法读取麦克风列表，请检查设备连接后重试。'));
    } finally {
      if (mounted.current && request === inputRequest.current) setMicrophonesBusy(false);
    }
  };
  useEffect(() => {
    const sync = () => setMicrophone(saved('voiceMicrophone', ''));
    window.addEventListener('surfacetab-voice-microphone', sync);
    return () => window.removeEventListener('surfacetab-voice-microphone', sync);
  }, []);
  useEffect(() => {
    if (open) {
      void refresh();
      void refreshMicrophones();
    }
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
    starting.current = true;
    shortcut.current.send = false;
    shortcut.current.heard = false;
    stopping.current = false;
    setListening(true);
    setFinishing(false);
    setLevels(Array(20).fill(0));
    setActiveInput('');
    const token = ++generation.current;
    let success = false;
    statusCallback.current(
      t(
        engine === 'windows-ai'
          ? '正在启动系统听写…'
          : '正在加载语音模型，首次运行可能需要较长时间…',
      ),
    );
    try {
      const started = await bridge.run({
        action: 'start',
        language: selected,
        engine,
        device,
        idleReleaseSeconds: getModelIdleSeconds(),
        microphone: engine === 'windows-sdk' ? '' : microphone,
      });
      if (!started.ok) {
        let key = started.error;
        if (key === 'windows-speech-timeout') {
          const stage = started.data?.stage;
          if (stage === 'model-loading') key = 'windows-speech-model-timeout';
          else if (stage === 'provider-register') key = 'windows-speech-provider-timeout';
          else if (stage === 'microphone-start' || stage === 'microphone-select')
            key = 'windows-speech-microphone-timeout';
        }
        if (key === 'windows-ai-unavailable' && started.data?.stage === 'model-loading')
          key = 'windows-speech-model-failed';
        throw Object.assign(new Error(key), { hresult: started.hresult });
      }
      if (token !== generation.current) return;
      starting.current = false;
      while (token === generation.current) {
        const next = await bridge.run({ action: 'read', id: started.data.id });
        if (token !== generation.current) return;
        if (!next.ok) throw new Error(next.error);
        if (next.data.text) {
          shortcut.current.heard = true;
          textCallback.current(next.data.text);
        }
        if (next.data.error) throw new Error(next.data.error);
        const level = Number(next.data.level) || 0;
        if (next.data.microphoneName) setActiveInput(next.data.microphoneName);
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
                  ? engine === 'windows-sdk'
                    ? '正在听写（Windows SDK），点击麦克风停止。'
                    : engine === 'windows-ai' && next.data.stage === 'microphone-start'
                      ? '正在启动系统听写，可开始说话，点击麦克风停止。'
                      : '正在离线听写，点击麦克风停止。'
                  : '正在加载语音模型，首次运行可能需要较长时间…',
          ) + suffix,
        );
        if (next.data.done) break;
      }
      statusCallback.current('');
      success = true;
    } catch (e) {
      if (token === generation.current) {
        const key = e instanceof Error ? e.message : '';
        const code = (e as { hresult?: string })?.hresult;
        statusCallback.current(
          t(errors[key] || errors.inference) +
            (typeof code === 'string' && /^0x[0-9a-f]{8}$/i.test(code) ? ` (${code})` : ''),
        );
        if (['runtime', 'model-missing'].includes(key)) setOpen(true);
        if (key !== 'busy') void bridge.run({ action: 'cancel' });
      }
    } finally {
      if (token === generation.current) {
        running.current = false;
        starting.current = false;
        release();
        stopping.current = false;
        setListening(false);
        setFinishing(false);
        if (success && shortcut.current.send) shortcutFinished.current?.();
        shortcut.current.send = false;
      }
    }
  };
  const begin = (selected = language) => {
    activePromise.current = start(selected);
  };
  useEffect(() => {
    if (!toggleRequest) {
      shortcut.current.seen = 0;
      return;
    }
    if (!toggleRequest || shortcut.current.seen === toggleRequest || disabled || settingBusy)
      return;
    shortcut.current.seen = toggleRequest;
    if (stopping.current) return;
    if (running.current) {
      stop();
    } else begin();
  }, [toggleRequest, disabled, settingBusy]);
  useEffect(() => {
    if (!sendRequest) {
      shortcut.current.sendSeen = 0;
      return;
    }
    if (!sendRequest || shortcut.current.sendSeen === sendRequest || disabled || settingBusy)
      return;
    shortcut.current.sendSeen = sendRequest;
    if (running.current) {
      shortcut.current.send = true;
      if (!stopping.current) stop();
    } else shortcutFinished.current?.();
  }, [sendRequest, disabled, settingBusy]);
  const prepareWindows = async (action: 'status' | 'register' | 'prepare') => {
    if (settingBusy || running.current) return;
    busyRef.current = 'windows';
    setSettingBusy('windows');
    setWindowsProgress(null);
    setMessage(t('正在准备系统语音模型…'));
    const task =
      action === 'prepare'
        ? backgroundTasks.begin(t('Windows 系统语音模型'), {
            open: () => setOpen(true),
            cancel: () => {
              void bridge?.run({ action: 'windows-cancel' });
            },
          })
        : null;
    windowsPreparation.current = task;
    try {
      const r = await bridge?.run({ action: `windows-${action}`, engine });
      if (task)
        backgroundTasks.finish(
          task,
          r?.ok ? t('Windows 语音组件已准备。') : t('Windows 系统语音模型准备失败。'),
        );
      if (mounted.current)
        setMessage(
          r?.ok
            ? action === 'status'
              ? `${t('Windows 语音状态')}: ${r.data?.state || 'Ready'}`
              : t('Windows 语音组件已准备。')
            : t(errors[r?.error || 'windows-ai-unavailable'] || errors['windows-ai-unavailable']) +
                (r?.hresult ? ` (${r.hresult})` : '') +
                (r?.data?.detail ? ` ${String(r.data.detail).slice(0, 600)}` : '') +
                (r?.data?.reason ? ` [${String(r.data.reason).slice(0, 100)}]` : ''),
        );
    } catch {
      if (task) backgroundTasks.finish(task, t('Windows 系统语音模型准备失败。'));
      if (mounted.current) setMessage(t(errors['windows-ai-unavailable']));
    } finally {
      windowsPreparation.current = null;
      busyRef.current = '';
      if (mounted.current) setSettingBusy('');
    }
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
        title={
          names[engine] +
          ' · ' +
          t(
            engine === 'windows-sdk'
              ? '可能使用在线语音服务；识别文字可编辑。'
              : '本地识别；识别文字可编辑，点击发送后才提交。',
          )
        }
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
      {listening && activeInput && (
        <span className="chat-voice-input" title={activeInput} role="status">
          {activeInput}
        </span>
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
            {t('麦克风')}
            <select
              aria-label={t('语音输入麦克风')}
              value={microphone}
              disabled={
                listening ||
                finishing ||
                microphonesBusy ||
                !!settingBusy ||
                engine === 'windows-sdk'
              }
              onChange={(e) => {
                save('voiceMicrophone', e.target.value);
                setMicrophone(e.target.value);
                window.dispatchEvent(new Event('surfacetab-voice-microphone'));
              }}
            >
              <option value="">
                {t('跟随系统默认')}
                {microphones.find((m) => m.id === defaultInput)?.name
                  ? ' · ' + microphones.find((m) => m.id === defaultInput)!.name
                  : ''}
              </option>
              {microphone && !microphones.some((m) => m.id === microphone) && (
                <option value={microphone} disabled>
                  {t('所选麦克风不可用')}
                </option>
              )}
              {microphones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={listening || finishing || microphonesBusy || !!settingBusy}
            onClick={() => void refreshMicrophones()}
          >
            {t(microphonesBusy ? '正在读取麦克风…' : '刷新麦克风列表')}
          </button>
          {microphoneError && <p role="status">{microphoneError}</p>}
          <p className="chat-voice-note">
            {t('本地引擎共用所选麦克风；Windows SDK 使用系统默认输入，不更改系统设置。')}
          </p>
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
                  : engine === 'windows-ai'
                    ? 'Windows AI 语音在本机识别；实验性接口，需要受支持的 Windows 11 与系统模型。设备由 Windows 自动选择。'
                    : engine === 'windows-sdk'
                      ? 'Windows SDK 听写可能使用在线语音服务，需要麦克风和在线语音识别权限。'
                      : '使用 Windows 已安装的离线语音识别包。',
            )}
          </p>
          {['windows-ai', 'windows-sdk'].includes(engine) && (
            <div className="row">
              <button
                disabled={!!settingBusy || listening || finishing}
                onClick={() => void prepareWindows('status')}
              >
                {t('检查 Windows 语音')}
              </button>
              <button
                disabled={!!settingBusy || listening || finishing}
                onClick={() => void prepareWindows('register')}
              >
                {t('注册语音组件权限')}
              </button>
              {engine === 'windows-ai' && (
                <button
                  disabled={!!settingBusy || listening || finishing}
                  onClick={() => void prepareWindows('prepare')}
                >
                  {t('准备 Windows 语音模型')}
                </button>
              )}
            </div>
          )}
          {engine === 'windows-ai' && (
            <p className="chat-voice-note">
              {t(
                '准备模型会通过 Windows Update 下载可选系统模型，可在 Windows 设置的 AI 组件中管理。',
              )}
            </p>
          )}
          {settingBusy === 'windows' && windowsPreparation.current && (
            <div className="chat-voice-readiness" role="status">
              <span>
                {windowsProgress
                  ? `${Math.round(windowsProgress.value * 100)}%`
                  : t('等待 Windows 返回模型进度…')}
              </span>
              <progress
                aria-label={t('系统语音模型准备进度')}
                max={1}
                value={windowsProgress?.value}
              />
            </div>
          )}
          {['sensevoice-small', 'whisper-small'].includes(engine) && (
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
