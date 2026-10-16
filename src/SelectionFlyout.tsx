import { t as tr, useLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import {
  Copy,
  Languages,
  Volume2,
  Square,
  X,
  Settings2,
  ArrowDown,
  ExternalLink,
  Pause,
  Play,
  MessageSquare,
} from 'lucide-react';
import { copyText } from './clipboard';
import {
  loadOpusDevice,
  nativeOpusEnabled,
  saveOpusDevice,
  setNativeOpusEnabled,
} from './nativeOpus';
import { normalizeTranslationText } from './translationText';
import { translationReady } from './translate';
import { nativeTexoHealth } from './nativeTexo';
import { useSpeech } from './useSpeech';
import { useProviderConfig } from './providerSettings';
import { ProviderAdvanced } from './ProviderAdvanced';
import { executeProvider, providerResultStatus, providerFailureStatus } from './providers';
import { useWritingHand } from './inputPreferences';
import { useSelectionPlacement } from './useSelectionPlacement';
import { useNativeKeyboard } from './nativeKeyboard';
import { loadHyMtDevice, saveHyMtDevice } from './nativeHyMt';
import {
  translationLanguages,
  recentTranslationTargets,
  rememberTranslationTarget,
  useRecentTranslationTargets,
} from './translationLanguages';
import './selectionFlyout.css';
export interface SelectionInfo {
  text: string;
  x: number;
  y: number;
  range?: Range;
  pageId?: string;
  pageNumber?: number;
}
function endpointLabel(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return tr('\u8BF7\u586B\u5199\u6709\u6548\u63A5\u53E3\u5730\u5740');
  }
}
export default function SelectionFlyout({
  selection,
  onClose,
  onAsk,
  standalone = false,
  open = true,
  onModels,
}: {
  selection: SelectionInfo;
  onClose: () => void;
  onAsk?: () => void;
  standalone?: boolean;
  open?: boolean;
  onModels?: () => void;
}) {
  useLocale();
  const api = useProviderConfig('translation', nativeOpusEnabled() ? 'local-native' : 'local');
  const { provider, patch, selectProvider } = api;
  const localProvider = ['local', 'local-native', 'hymt2', 'hymt2-openvino'].includes(
    provider.type,
  );
  const [hyMtDevice, setHyMtDevice] = useState(() => loadHyMtDevice());
  const [hyMtOvDevice, setHyMtOvDevice] = useState(() => loadHyMtDevice(true));
  const [expanded, setExpanded] = useState(standalone),
    [config, setConfig] = useState(false),
    [translation, setTranslation] = useState(''),
    [target, setTarget] = useState(() => recentTranslationTargets()[0] ?? 'zh-CN'),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const [source, setSource] = useState(selection.text);
  const sourceText = standalone ? source : selection.text;
  const recentTargets = useRecentTranslationTargets();
  const nativeKeyboard = useNativeKeyboard();
  const {
    speak,
    stop,
    speaking,
    rate,
    setRate,
    settings: speechSettings,
    paused,
    pause,
    resume,
    playbackReady,
  } = useSpeech(setStatus);
  const [copied, setCopied] = useState(false);
  const hand = useWritingHand();
  const { ref, position } = useSelectionPlacement(selection, hand, expanded, open);
  const fallback = provider.fallback,
    setFallback = (value: boolean) => patch({ fallback: value });
  const [opusDevice, setOpusDevice] = useState(loadOpusDevice);
  const abort = useRef<AbortController | null>(null);
  const warmCheck = useRef<AbortController | null>(null);
  useEffect(() => {
    warmCheck.current?.abort();
  }, [provider.type, target]);
  useEffect(() => {
    abort.current?.abort();
    warmCheck.current?.abort();
    stop();
    setBusy(false);
    setExpanded(standalone);
    setTranslation('');
    setStatus('');
  }, [selection.text]);
  useEffect(() => {
    if (!open) {
      abort.current?.abort();
      warmCheck.current?.abort();
      stop();
      setBusy(false);
    }
  }, [open]);
  useEffect(() => {
    if (!standalone || !open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [standalone, open, onClose]);
  const changeInput = () => {
    abort.current?.abort();
    warmCheck.current?.abort();
    stop();
    setBusy(false);
    setTranslation('');
    setStatus('');
  };
  const chooseTarget = (value: string) => {
    if (value !== target) changeInput();
    setTarget(value);
    rememberTranslationTarget(value);
  };
  useEffect(
    () => () => {
      abort.current?.abort();
      warmCheck.current?.abort();
      speechSynthesis?.cancel();
    },
    [],
  );
  const copy = (text: string) =>
    void copyText(text)
      .then(() => {
        setStatus(tr('\u5DF2\u590D\u5236'));
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() =>
        setStatus(tr('\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u62E9\u6587\u672C')),
      );
  const translate = async () => {
    if (busy || !api.ready) return;
    const text = normalizeTranslationText(sourceText);
    if (!text) return;
    rememberTranslationTarget(target);
    if (provider.type === 'google' && !provider.key.trim() && navigator.onLine) {
      window.open(
        `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(target)}&text=${encodeURIComponent(text)}&op=translate`,
        '_blank',
        'noopener,noreferrer',
      );
      setStatus(
        tr(
          '\u5DF2\u6253\u5F00 Google \u7FFB\u8BD1\uFF1B\u7F51\u9875\u65E0\u6CD5\u8FDE\u63A5\u65F6\uFF0C\u53EF\u70B9\u51FB\u201C\u672C\u5730\u7FFB\u8BD1\u201D\u3002\u914D\u7F6E Cloud API Key \u540E\u53EF\u5728\u6B64\u663E\u793A\u8BD1\u6587\u3002',
        ),
      );
      return;
    }
    setBusy(true);
    setStatus(tr('\u6B63\u5728\u7FFB\u8BD1\u2026'));
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const valid = () => abort.current === controller && !controller.signal.aborted;
    try {
      const result = await executeProvider(
        {
          feature: 'translation',
          config: provider,
          input: text,
          target,
          device:
            provider.type === 'hymt2-openvino'
              ? hyMtOvDevice
              : provider.type === 'hymt2'
                ? hyMtDevice
                : opusDevice,
          localPreference: nativeOpusEnabled() ? 'local-native' : 'local',
        },
        {
          signal: controller.signal,
          onProgress: (value) => {
            if (valid()) setStatus(value);
          },
          onPartial: (value) => {
            if (valid()) setTranslation(value);
          },
        },
      );
      if (valid()) {
        setTranslation(result.text ?? '');
        setStatus(providerResultStatus(result));
      }
    } catch (error) {
      if (valid()) setStatus(providerFailureStatus(error, !localProvider));
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };
  const revealTranslation = async () => {
    warmCheck.current?.abort();
    setExpanded(!expanded);
    if (
      expanded ||
      translation ||
      busy ||
      !api.ready ||
      !['local', 'local-native'].includes(provider.type)
    )
      return;
    const controller = new AbortController();
    warmCheck.current = controller;
    let ready = translationReady(target);
    if (!ready && provider.type === 'local-native') {
      try {
        const health = await nativeTexoHealth(controller.signal);
        ready =
          health.loaded &&
          health.modelKind?.[0] === 'opus' &&
          health.modelKind[1] === (target === 'en' ? 'zh-en' : 'en-zh');
      } catch {
        /* Do not start a backend merely to expand the flyout. */
      }
    }
    if (ready && !controller.signal.aborted) void translate();
  };
  return (
    <div
      ref={ref}
      className={`selection-flyout ${expanded ? 'expanded' : ''} ${standalone ? 'standalone-translation' : ''}`}
      data-writing-hand={hand}
      data-placement={position.side}
      style={{
        display: open ? undefined : 'none',
        left: position.left,
        top: position.top,
        width: position.width,
        height: expanded ? position.height : undefined,
        maxHeight: position.maxHeight,
      }}
      role="dialog"
      aria-label={tr(standalone ? '翻译界面' : '划词工具')}
      onPointerDown={(e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement).closest('button,a')) e.preventDefault();
      }}
    >
      <div className="selection-actions">
        <button title={tr('复制选区')} aria-label={tr('复制选区')} onClick={() => copy(sourceText)}>
          {copied ? <span className="copy-done">{tr('已复制')}</span> : <Copy size={16} />}
        </button>
        <button
          disabled={!api.ready || (standalone && !sourceText.trim())}
          onClick={() => (standalone ? void translate() : void revealTranslation())}
        >
          <Languages size={16} />
          {tr('翻译')}
        </button>
        <button aria-label={tr('朗读选区')} onClick={() => speak(sourceText)}>
          <Volume2 size={17} />
        </button>
        {speaking && (
          <>
            {playbackReady && (
              <button
                aria-label={tr(paused ? '继续朗读' : '暂停朗读')}
                onClick={paused ? resume : pause}
              >
                {paused ? <Play size={16} /> : <Pause size={16} />}
              </button>
            )}
            <button aria-label={tr('停止朗读')} onClick={stop}>
              <Square size={16} />
            </button>
          </>
        )}
        {onAsk && (
          <button aria-label={tr('询问 ChatGPT')} title={tr('询问 ChatGPT')} onClick={onAsk}>
            <MessageSquare size={16} />
          </button>
        )}
        <button aria-label={tr(standalone ? '关闭翻译界面' : '关闭划词工具')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {expanded && (
        <div className="translation-content">
          <div className="translation-heading">
            <span>
              TixTab <b>Translate</b>
            </span>
            <button
              className="icon-button"
              aria-label={tr('翻译后端设置')}
              onClick={() => setConfig(!config)}
            >
              <Settings2 size={15} />
            </button>
          </div>
          {config && (
            <div className="provider-config">
              {speechSettings}
              <label>
                {tr('翻译后端')}
                <select
                  disabled={busy || !api.ready}
                  aria-label={tr('翻译后端类型')}
                  value={provider.type}
                  onChange={(e) => {
                    const type = e.target.value;
                    if (['local', 'local-native'].includes(type))
                      setNativeOpusEnabled(type === 'local-native');
                    selectProvider(type);
                  }}
                >
                  <option value="local">{tr('本地内置 · OPUS 中英翻译')}</option>
                  <option value="local-native">
                    {tr('本地实验 · OPUS OpenVINO（NPU/GPU/CPU）')}
                  </option>
                  <option value="hymt2">{tr('本地 · Hy-MT2 1.8B（CPU / GPU）')}</option>
                  <option value="hymt2-openvino">
                    {tr('本地实验 · Hy-MT2 OpenVINO（CPU / GPU / NPU）')}
                  </option>
                  <option value="local-service">{tr('本地 HTTP 翻译服务')}</option>
                  <option value="google">{tr('在线 · Google 翻译（默认）')}</option>
                  <option value="web">{tr('自定义网页 HTTP API')}</option>
                  <option value="llm">{tr('LLM API（OpenAI 兼容）')}</option>
                </select>
              </label>
              {provider.type === 'local-native' && (
                <>
                  <label>
                    {tr('翻译计算设备')}
                    <select
                      aria-label={tr('翻译计算设备')}
                      value={opusDevice}
                      onChange={(e) => {
                        const device = e.target.value as typeof opusDevice;
                        setOpusDevice(device);
                        saveOpusDevice(device);
                      }}
                    >
                      <option value="AUTO">{tr('自动 · NPU → GPU → CPU')}</option>
                      <option value="NPU">Intel NPU</option>
                      <option value="GPU">Intel GPU</option>
                      <option value="CPU">CPU</option>
                    </select>
                  </label>
                  <small>
                    {tr(
                      '实验性量化路径，译文可能与内置模型不同，请核对公式、数字与专有名词。编码器优先低功耗设备，解码器使用 CPU；不可用时回退内置模型。',
                    )}
                  </small>
                </>
              )}
              {provider.type.startsWith('hymt2') && (
                <>
                  <label>
                    {tr('翻译计算设备')}
                    <select
                      aria-label={tr('翻译计算设备')}
                      value={provider.type === 'hymt2-openvino' ? hyMtOvDevice : hyMtDevice}
                      disabled={busy}
                      onChange={(e) => {
                        const value = e.target.value as typeof hyMtDevice;
                        const ov = provider.type === 'hymt2-openvino';
                        (ov ? setHyMtOvDevice : setHyMtDevice)(value);
                        saveHyMtDevice(value, ov);
                      }}
                    >
                      <option value="CPU">CPU</option>
                      <option value="GPU">
                        GPU {provider.type === 'hymt2-openvino' ? '(OpenVINO)' : '(Vulkan)'}
                      </option>
                      {provider.type === 'hymt2-openvino' && (
                        <option value="NPU">NPU (OpenVINO · {tr('实验性')})</option>
                      )}
                      <option value="AUTO">{tr('自动 · GPU → CPU')}</option>
                    </select>
                  </label>
                  <small>
                    {tr(
                      '首次需在本地模型管理下载 Hy-MT2 1.8B Q4_K_M（约 1.13 GB）及共享 llama.cpp 运行库；复用现有环境，支持中英日韩法翻译。',
                    )}
                  </small>
                  {provider.type === 'hymt2-openvino' && (
                    <small>
                      {tr(
                        'OpenVINO 另需下载对应运行库，复用同一份模型权重。NPU 路径为实验性，限制较短上下文；不可用时会报告错误，不会伪装成 NPU 成功。',
                      )}
                    </small>
                  )}
                  {onModels && <button onClick={onModels}>{tr('本地模型管理')}</button>}
                </>
              )}
              {!localProvider && (
                <>
                  <label>
                    {tr('接口地址')}
                    <input
                      disabled={busy || !api.ready || provider.type === 'google'}
                      maxLength={2048}
                      aria-label={tr('翻译接口地址')}
                      value={provider.url}
                      onChange={(e) => patch({ url: e.target.value })}
                    />
                  </label>
                  {provider.type === 'llm' && (
                    <label>
                      {tr('模型')}
                      <input
                        disabled={busy || !api.ready}
                        maxLength={256}
                        aria-label={tr('翻译模型')}
                        value={provider.model}
                        onChange={(e) => patch({ model: e.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    {provider.type === 'google'
                      ? tr('Google Cloud API Key（可选）')
                      : tr('API Key')}
                    <input
                      disabled={busy || !api.ready}
                      type="password"
                      maxLength={8192}
                      aria-label={tr('翻译 API Key')}
                      autoComplete="off"
                      value={provider.key}
                      onChange={(e) => patch({ key: e.target.value })}
                    />
                  </label>
                </>
              )}
              <small>
                {provider.type.startsWith('hymt2')
                  ? tr('本地 Hy-MT2，按需运行；闲置释放时间遵循设置。')
                  : localProvider
                    ? tr(
                        '内置中英双向开源模型，无需启动服务或配置密钥；首次加载较慢，闲置后自动释放。',
                      )
                    : provider.type === 'google'
                      ? tr(
                          '无密钥时打开 Google 翻译网页；填入启用了 Cloud Translation API 的密钥后，译文直接显示在浮窗。',
                        )
                      : tr(
                          '只在点击翻译后发送当前选区。HTTP 接口需返回 translatedText / translation。',
                        )}
              </small>
              {!localProvider && (
                <ProviderAdvanced feature="translation" {...api} disabled={busy} />
              )}
              <label className="local-fallback">
                <input
                  type="checkbox"
                  aria-label={tr('远程失败回退本地')}
                  checked={fallback}
                  onChange={(e) => setFallback(e.target.checked)}
                />
                {tr('远程失败时使用本地中英翻译')}
              </label>
            </div>
          )}
          <div className="translation-language">
            <span>{tr('自动检测')}</span>
            <button
              className="icon-button"
              aria-label={tr('朗读原文')}
              onClick={() => speak(sourceText)}
            >
              <Volume2 size={14} />
            </button>
            <button className="icon-button" title={tr('复制原文')} onClick={() => copy(sourceText)}>
              <Copy size={13} />
            </button>
          </div>
          {standalone ? (
            <textarea
              className="translation-source translation-input"
              aria-label={tr('翻译原文')}
              placeholder={tr('输入或粘贴要翻译的内容')}
              inputMode={nativeKeyboard ? 'text' : 'none'}
              maxLength={20000}
              value={source}
              onChange={(e) => {
                changeInput();
                setSource(e.target.value);
              }}
            />
          ) : (
            <div className="translation-source">{selection.text}</div>
          )}
          <div className="translation-divider">
            <ArrowDown size={14} />
          </div>
          <div className="translation-language">
            <select
              aria-label={tr('翻译目标语言')}
              value={target}
              onChange={(e) => chooseTarget(e.target.value)}
            >
              {translationLanguages.map((language) => (
                <option key={language.id} value={language.id}>
                  {tr(language.label)}
                </option>
              ))}
            </select>
            <div className="translation-recent" role="group" aria-label={tr('最近目标语言')}>
              {recentTargets.map((id) => (
                <button key={id} aria-pressed={target === id} onClick={() => chooseTarget(id)}>
                  {tr(translationLanguages.find((item) => item.id === id)!.label)}
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              title={tr('朗读译文')}
              disabled={!translation}
              onClick={() => speak(translation)}
            >
              <Volume2 size={14} />
            </button>
            <button
              className="icon-button"
              title={tr('复制译文')}
              disabled={!translation}
              onClick={() => copy(translation)}
            >
              <Copy size={13} />
            </button>
          </div>
          <div className={`translation-result ${translation ? '' : 'empty'}`}>
            {translation || tr('让阅读继续，语言不再打断思路。')}
          </div>
          <div className="translation-footer">
            <span>
              {localProvider
                ? provider.type.startsWith('hymt2')
                  ? 'Hy-MT2 1.8B'
                  : tr('本地优先')
                : provider.type === 'google'
                  ? tr('Google 翻译')
                  : endpointLabel(provider.url)}
            </span>
            <button
              aria-label={tr('使用本地翻译')}
              disabled={busy || !api.ready}
              onClick={() => {
                setNativeOpusEnabled(false);
                selectProvider('local');
                setStatus(tr('已选择本地内置模型，点击翻译开始。'));
              }}
            >
              {tr('本地翻译')}
            </button>
            <label className="tts-rate">
              {tr('语速')}
              <input
                type="range"
                aria-label={tr('朗读语速')}
                min=".5"
                max="2"
                step=".1"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
              />
            </label>
            <button
              className="primary"
              disabled={busy || !api.ready || !sourceText.trim()}
              onClick={translate}
            >
              {busy ? tr('翻译中…') : tr('翻译')}
            </button>
            {busy && (
              <button
                onClick={() => {
                  abort.current?.abort();
                  setBusy(false);
                  setStatus(tr('已取消'));
                }}
              >
                {tr('取消翻译')}
              </button>
            )}
          </div>
          <p className="translation-status" role="status">
            {tr(status) ||
              tr(standalone ? '输入原文后点击翻译。' : '选中文字，按笔侧键或右键，随时查词。')}
          </p>
        </div>
      )}
      {!expanded && status && (
        <p className="translation-status compact-speech-status" role="status">
          {tr(status)}
        </p>
      )}
    </div>
  );
}
