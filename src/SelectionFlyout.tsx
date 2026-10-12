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
}: {
  selection: SelectionInfo;
  onClose: () => void;
  onAsk?: () => void;
}) {
  useLocale();
  const api = useProviderConfig('translation', nativeOpusEnabled() ? 'local-native' : 'local');
  const { provider, patch, selectProvider } = api;
  const [expanded, setExpanded] = useState(false),
    [config, setConfig] = useState(false),
    [translation, setTranslation] = useState(''),
    [target, setTarget] = useState('zh-CN'),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
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
  const { ref, position } = useSelectionPlacement(selection, hand, expanded);
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
    setExpanded(false);
    setTranslation('');
    setStatus('');
  }, [selection.text]);
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
    const text = normalizeTranslationText(selection.text);
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
          device: opusDevice,
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
      if (valid())
        setStatus(providerFailureStatus(error, !['local', 'local-native'].includes(provider.type)));
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
      className={`selection-flyout ${expanded ? 'expanded' : ''}`}
      data-writing-hand={hand}
      data-placement={position.side}
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
      role="dialog"
      aria-label={tr('划词工具')}
      onPointerDown={(e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement).closest('button,a')) e.preventDefault();
      }}
    >
      <div className="selection-actions">
        <button
          title={tr('复制选区')}
          aria-label={tr('复制选区')}
          onClick={() => copy(selection.text)}
        >
          {copied ? <span className="copy-done">{tr('已复制')}</span> : <Copy size={16} />}
        </button>
        <button disabled={!api.ready} onClick={() => void revealTranslation()}>
          <Languages size={16} />
          {tr('翻译')}
        </button>
        <button aria-label={tr('朗读选区')} onClick={() => speak(selection.text)}>
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
        <button aria-label={tr('关闭划词工具')} onClick={onClose}>
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
              {!['local', 'local-native'].includes(provider.type) && (
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
                {['local', 'local-native'].includes(provider.type)
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
              {!['local', 'local-native'].includes(provider.type) && (
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
              onClick={() => speak(selection.text)}
            >
              <Volume2 size={14} />
            </button>
            <button
              className="icon-button"
              title={tr('复制原文')}
              onClick={() => copy(selection.text)}
            >
              <Copy size={13} />
            </button>
          </div>
          <div className="translation-source">{selection.text}</div>
          <div className="translation-divider">
            <ArrowDown size={14} />
          </div>
          <div className="translation-language">
            <select
              aria-label={tr('翻译目标语言')}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="zh-CN">{tr('简体中文')}</option>
              <option value="en">English</option>
              <option value="ja">{tr('日本語')}</option>
              <option value="ko">한국어</option>
              <option value="fr">Français</option>
            </select>
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
              {['local', 'local-native'].includes(provider.type)
                ? tr('本地优先')
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
            <button className="primary" disabled={busy || !api.ready} onClick={translate}>
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
            {tr(status) || tr('选中文字，按笔侧键或右键，随时查词。')}
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
