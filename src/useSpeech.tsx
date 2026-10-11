import { t as tr, useLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import {
  loadSpeechDevice,
  loadSpeechProvider,
  saveSpeechDevice,
  saveSpeechProvider,
} from './nativeTts';
import { normalizeTranslationText } from './translationText';
import { useProviderConfig } from './providerSettings';
import { ProviderAdvanced } from './ProviderAdvanced';
import { destination } from './remoteProvider';
import { executeProvider, providerResultStatus, providerFailureStatus } from './providers';
export function useSpeech(onStatus: (status: string) => void) {
  useLocale();
  const api = useProviderConfig('speech', loadSpeechProvider());
  const { provider: config, patch, selectProvider } = api,
    provider = config.type;
  const [speaking, setSpeaking] = useState(false),
    [rate, setRate] = useState(1);
  const [device, setDevice] = useState(loadSpeechDevice),
    [paused, setPaused] = useState(false),
    [playbackReady, setPlaybackReady] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null),
    objectUrl = useRef(''),
    controller = useRef<AbortController | null>(null);
  const stop = () => {
    controller.current?.abort();
    controller.current = null;
    audio.current?.pause();
    audio.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = '';
    speechSynthesis.cancel();
    setSpeaking(false);
    setPaused(false);
    setPlaybackReady(false);
  };
  const pause = () => {
    if (!playbackReady) return;
    if (audio.current) audio.current.pause();
    else speechSynthesis.pause();
    setPaused(true);
  };
  const resume = () => {
    if (!playbackReady) return;
    if (audio.current)
      void audio.current
        .play()
        .then(() => setPaused(false))
        .catch(() => {
          stop();
          onStatus(tr('音频播放失败'));
        });
    else {
      speechSynthesis.resume();
      setPaused(false);
    }
  };
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);
  useEffect(() => stop, []);
  const speak = async (source: string) => {
    if (!api.ready) {
      onStatus(tr('正在读取后端配置…'));
      return;
    }
    stop();
    const current = new AbortController();
    controller.current = current;
    setSpeaking(true);
    const text = normalizeTranslationText(source),
      valid = () => controller.current === current && !current.signal.aborted;
    const status = (value: string) => {
      if (valid()) onStatus(value);
    };
    try {
      if (['web', 'llm'].includes(provider))
        status(tr('发送至：{0}', destination(config, 'speech')));
      const result = await executeProvider(
        { feature: 'speech', config, input: text, device, localPreference: loadSpeechProvider() },
        { signal: current.signal, onProgress: status },
      );
      if (!valid()) return;
      status(providerResultStatus(result));
      if (result.systemVoice) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = result.systemVoice;
        utterance.rate = rate;
        utterance.onend = () => {
          if (valid()) stop();
        };
        utterance.onerror = () => {
          if (valid()) {
            stop();
            onStatus(tr('系统朗读失败'));
          }
        };
        speechSynthesis.speak(utterance);
        setPlaybackReady(true);
        return;
      }
      if (!result.audio) throw new Error(tr('音频播放失败'));
      const player = new Audio();
      objectUrl.current = URL.createObjectURL(result.audio);
      player.src = objectUrl.current;
      player.playbackRate = rate;
      audio.current = player;
      player.onended = () => {
        if (valid()) stop();
      };
      player.onerror = () => {
        if (valid()) {
          stop();
          onStatus(tr('音频播放失败'));
        }
      };
      await player.play();
      if (valid()) setPlaybackReady(true);
    } catch (error) {
      if (valid()) {
        stop();
        onStatus(providerFailureStatus(error, ['web', 'llm'].includes(provider)));
      }
    }
  };
  const settings = (
    <details className="speech-settings">
      <summary>{tr('朗读后端')}</summary>
      <label>
        {tr('语音后端')}
        <select
          disabled={speaking || !api.ready}
          aria-label={tr('语音后端')}
          value={provider}
          onChange={(e) => {
            stop();
            selectProvider(e.target.value);
            saveSpeechProvider(e.target.value);
          }}
        >
          <option value="native">{tr('本地低功耗优先 · Piper（实验）')}</option>
          <option value="local">{tr('本地 Piper · 中英')}</option>
          <option value="system">{tr('系统离线声音')}</option>
          <option value="web">{tr('HTTP 语音 API')}</option>
          <option value="llm">{tr('OpenAI 兼容语音 API')}</option>
        </select>
      </label>
      {provider === 'native' && (
        <>
          <label>
            {tr('朗读计算设备')}
            <select
              aria-label={tr('朗读计算设备')}
              value={device}
              onChange={(e) => {
                stop();
                const next = e.target.value as typeof device;
                setDevice(next);
                saveSpeechDevice(next);
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
              '波形生成优先 NPU/GPU，音素、时长与尾段使用 CPU；短句可能全部使用 CPU。不可用时回退内置 Piper。首次安装原生组件：backend/start-openvino.ps1 -Install。',
            )}
          </small>
        </>
      )}
      {['web', 'llm'].includes(provider) && (
        <>
          <label>
            {tr('接口地址')}
            <input
              disabled={speaking || !api.ready}
              maxLength={2048}
              aria-label={tr('语音接口地址')}
              value={config.url}
              onChange={(e) => patch({ url: e.target.value })}
            />
          </label>
          <label>
            API Key
            <input
              disabled={speaking || !api.ready}
              maxLength={8192}
              autoComplete="off"
              type="password"
              aria-label={tr('语音 API Key')}
              value={config.key}
              onChange={(e) => patch({ key: e.target.value })}
            />
          </label>
          {provider === 'llm' && (
            <label>
              {tr('模型')}
              <input
                disabled={speaking || !api.ready}
                maxLength={256}
                aria-label={tr('语音模型')}
                value={config.model}
                onChange={(e) => patch({ model: e.target.value })}
              />
            </label>
          )}
          <label>
            {tr('声音 ID')}
            <input
              disabled={speaking || !api.ready}
              maxLength={128}
              aria-label={tr('声音 ID')}
              value={config.voice}
              onChange={(e) => patch({ voice: e.target.value })}
            />
          </label>
          <label className="provider-checkbox">
            <input
              disabled={speaking || !api.ready}
              type="checkbox"
              checked={config.fallback}
              onChange={(e) => patch({ fallback: e.target.checked })}
            />
            {tr('远程失败时使用本地后端')}
          </label>
          <ProviderAdvanced feature="speech" {...api} disabled={speaking} />
        </>
      )}
    </details>
  );
  return { speak, stop, speaking, rate, setRate, settings, paused, pause, resume, playbackReady };
}
