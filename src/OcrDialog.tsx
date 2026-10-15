import WindowsAiOcrSettings from './WindowsAiOcrSettings';
import TaskCenterButton from './TaskCenterButton';
import NativeCppOcrSettings from './NativeCppOcrSettings';
import { t as tr, useLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { loadNativeDevice } from './nativeTexo';
import { copyText } from './clipboard';
import { useProviderConfig } from './providerSettings';
import { ProviderAdvanced } from './ProviderAdvanced';
import { executeProvider, providerResultStatus, providerFailureStatus } from './providers';
import { loadOcrDevice, saveOcrDevice, loadOcrProvider, saveOcrProvider } from './nativeOcr';
export default function OcrDialog({
  image,
  onClose,
  onRead,
}: {
  image: string;
  onClose: () => void;
  onRead: (text: string) => void;
}) {
  useLocale();
  const api = useProviderConfig('ocr', loadOcrProvider());
  const { provider: config, patch, selectProvider } = api,
    provider = config.type,
    fallback = config.fallback;
  const [text, setText] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const [device, setDevice] = useState(loadOcrDevice);
  const abort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );
  const recognize = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(tr('\u8BC6\u522B\u4E2D\u2026'));
    const valid = () => abort.current === controller && !controller.signal.aborted;
    try {
      const result = await executeProvider(
        {
          feature: 'ocr',
          config,
          input: image,
          device: provider === 'texo' ? loadNativeDevice() : device,
          localPreference: loadOcrProvider(),
        },
        {
          signal: controller.signal,
          onProgress: (value) => {
            if (valid()) setStatus(value);
          },
          onPartial: (value) => {
            if (valid()) setText(value);
          },
        },
      );
      if (valid()) {
        setText(result.text ?? '');
        setStatus(providerResultStatus(result));
      }
    } catch (error) {
      if (valid()) setStatus(providerFailureStatus(error, ['web', 'llm'].includes(provider)));
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };
  return (
    <div className="modal-scrim">
      <section
        className="modal ocr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tr('区域识别')}
      >
        <header>
          <h2>{tr('区域识别')}</h2>
          <button onClick={onClose}>{tr('关闭')}</button>
        </header>
        <div className="ocr-body">
          <img src={image} alt={tr('选中区域')} />
          <label>
            {tr('识别后端')}
            <select
              aria-label={tr('OCR 后端')}
              value={provider}
              disabled={busy || !api.ready}
              onChange={(e) => {
                selectProvider(e.target.value);
                saveOcrProvider(e.target.value);
              }}
            >
              <option value="native">{tr('本地低功耗优先 · PP-OCRv4（实验）')}</option>
              <option value="local">{tr('本地 Tesseract · 中英文字')}</option>
              <option value="windows-ai" disabled={!window.surfaceDesktop?.windowsAiOcr}>
                Windows AI OCR · NPU
              </option>
              <option value="tesseract-native" disabled={!window.surfaceDesktop?.nativeOcr}>
                Tesseract · C++
              </option>
              <option value="texo">{tr('本地 Texo · 公式转 LaTeX')}</option>
              <option value="web">HTTP OCR API</option>
              <option value="llm">{tr('图像 LLM API')}</option>
            </select>
          </label>
          {provider === 'windows-ai' && <WindowsAiOcrSettings disabled={busy} />}
          {provider === 'tesseract-native' && (
            <NativeCppOcrSettings
              value={config.model}
              disabled={busy}
              onChange={(model) => patch({ model })}
            />
          )}
          {provider === 'native' && (
            <details className="native-settings">
              <summary>{tr('本地加速设置')}</summary>
              <label>
                {tr('推理设备')}
                <select
                  aria-label={tr('OCR 推理设备')}
                  disabled={busy}
                  value={device}
                  onChange={(e) => {
                    const next = e.target.value as typeof device;
                    setDevice(next);
                    saveOcrDevice(next);
                  }}
                >
                  <option value="AUTO">{tr('自动 · NPU → GPU → CPU')}</option>
                  <option value="NPU">NPU</option>
                  <option value="GPU">GPU</option>
                  <option value="CPU">CPU</option>
                </select>
              </label>
              <p>
                {tr(
                  '优先使用本地 NPU/GPU；部分步骤使用 CPU。未安装加速组件时回退 Tesseract。文字与数字可能识别错误，公式请选择 Texo。',
                )}
              </p>
              <p>{tr('首次安装 OCR 加速：运行 backend/start-openvino.ps1 -Install -Ocr。')}</p>
            </details>
          )}
          {['web', 'llm'].includes(provider) && (
            <fieldset className="provider-config" disabled={busy || !api.ready}>
              <label>
                {tr('接口地址')}
                <input
                  maxLength={2048}
                  aria-label={tr('OCR 接口地址')}
                  value={config.url}
                  onChange={(e) => patch({ url: e.target.value })}
                />
              </label>
              {provider === 'llm' && (
                <label>
                  {tr('模型')}
                  <input
                    maxLength={256}
                    aria-label={tr('OCR 模型')}
                    value={config.model}
                    onChange={(e) => patch({ model: e.target.value })}
                  />
                </label>
              )}
              <label>
                API Key
                <input
                  type="password"
                  maxLength={8192}
                  autoComplete="off"
                  aria-label={tr('OCR API Key')}
                  value={config.key}
                  onChange={(e) => patch({ key: e.target.value })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={fallback}
                  onChange={(e) => patch({ fallback: e.target.checked })}
                />
                {tr('失败时回退本地 OCR')}
              </label>
              <ProviderAdvanced feature="ocr" {...api} disabled={busy} />
            </fieldset>
          )}
          <label className="field-label" htmlFor="ocr-result">
            {tr('识别结果 · 可修改')}
          </label>
          <textarea id="ocr-result" value={text} onChange={(e) => setText(e.target.value)} />
          <p className="ocr-task-status" role="status">
            {tr(status)}
          </p>
          <footer>
            <TaskCenterButton />
            <button
              disabled={!text}
              onClick={() =>
                void copyText(text)
                  .then(() => setStatus(tr('已复制')))
                  .catch(() => setStatus(tr('复制失败')))
              }
            >
              {tr('复制')}
            </button>
            <button disabled={!text} onClick={() => onRead(text)}>
              {tr('翻译 / 朗读')}
            </button>
            {busy ? (
              <button
                onClick={() => {
                  abort.current?.abort();
                  setBusy(false);
                  setStatus(tr('已取消'));
                }}
              >
                {tr('取消识别')}
              </button>
            ) : (
              <button className="primary" disabled={!api.ready} onClick={recognize}>
                {tr('开始识别')}
              </button>
            )}
          </footer>
        </div>
      </section>
    </div>
  );
}
