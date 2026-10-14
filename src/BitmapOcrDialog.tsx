import { useEffect, useRef, useState } from 'react';
import { X, ScanText } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Page } from './model';
import { t, useLocale } from './i18n';
import { parsePageRange } from './pdfInsertion';
import { scanBitmapPages } from './bitmapOcr';
import { executeProvider, providerFailureStatus } from './providers';
import { useProviderConfig } from './providerSettings';
import { loadOcrDevice, loadOcrProvider } from './nativeOcr';
import { ProviderAdvanced } from './ProviderAdvanced';
import './bitmapOcr.css';
export default function BitmapOcrDialog({
  pages,
  pdf,
  onApply,
  onClose,
}: {
  pages: Page[];
  pdf: PDFDocumentProxy | null;
  onApply: (pages: Page[]) => void;
  onClose: () => void;
}) {
  useLocale();
  const api = useProviderConfig('ocr', loadOcrProvider());
  const [range, setRange] = useState(''),
    [all, setAll] = useState(true),
    [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [count, setCount] = useState(0);
  const controller = useRef<AbortController | null>(null),
    alive = useRef(true),
    closing = useRef(false);
  const close = () => {
    if (controller.current) {
      closing.current = true;
      controller.current.abort();
    } else onClose();
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [onClose]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  let indices: number[] = [];
  try {
    if (!all && !range.trim()) throw new Error('page-range');
    indices = parsePageRange(all ? '' : range, pages.length);
  } catch {
    /* Display validation below. */
  }
  useEffect(() => {
    if (api.ready && api.provider.type === 'texo') api.selectProvider(loadOcrProvider());
  }, [api.ready, api.provider.type]);
  const start = async () => {
    if (busy || !indices.length) return;
    const abort = new AbortController();
    controller.current = abort;
    const completed = new Map<string, Page>();
    let images = 0;
    setBusy(true);
    setCount(0);
    setStatus(t('正在解析位图…'));
    try {
      await scanBitmapPages(
        indices.map((i) => pages[i]),
        pdf,
        {
          signal: abort.signal,
          replace,
          onPage: (p) => completed.set(p.id, p),
          onImage: () => {
            if (alive.current) setCount(++images);
          },
          recognize: async (image) =>
            executeProvider(
              {
                feature: 'ocr',
                input: image,
                ocrLayout: true,
                config: api.provider,
                device: loadOcrDevice(),
                localPreference: loadOcrProvider(),
              },
              {
                signal: abort.signal,
                onProgress: (s) => {
                  if (alive.current) setStatus(s);
                },
              },
            ),
        },
      );
      if (alive.current) setStatus(t('解析完成：{0} 张位图，可在全文搜索中检索', images));
    } catch (error) {
      if (alive.current)
        setStatus(
          abort.signal.aborted
            ? t('已停止，保留已完成的识别结果')
            : providerFailureStatus(error, ['web', 'llm'].includes(api.provider.type)),
        );
    } finally {
      if (alive.current) {
        if (completed.size) onApply([...completed.values()]);
        setBusy(false);
        if (closing.current) onClose();
      }
      controller.current = null;
    }
  };
  return (
    <div className="modal-scrim">
      <section
        className="modal bitmap-ocr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('解析位图')}
      >
        <header>
          <h2>
            <ScanText size={18} />
            {t('解析位图')}
          </h2>
          <button className="icon-button" aria-label={t('关闭')} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <fieldset disabled={busy}>
          <label>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            {t('全文')}
          </label>
          {!all && (
            <label>
              {t('页码范围')}
              <input
                aria-label={t('页码范围')}
                value={range}
                onChange={(e) => setRange(e.target.value)}
                placeholder="1-3, 5, 8"
                maxLength={2048}
              />
            </label>
          )}
          {!indices.length && <span role="alert">{t('请输入有效页码范围')}</span>}
          <label>
            {t('OCR 后端')}
            <select
              aria-label={t('OCR 后端')}
              value={api.provider.type}
              onChange={(e) => api.selectProvider(e.target.value)}
              disabled={!api.ready}
            >
              <option value="native">PP-OCRv4 · {t('本地')}</option>
              <option value="local">Tesseract · {t('本地')}</option>
              <option value="web">HTTP OCR API</option>
              <option value="llm">LLM API</option>
            </select>
          </label>
          <details className="native-settings">
            <summary>{t('设置')}</summary>
            <label>
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              {t('重新识别已有结果')}
            </label>
            {['web', 'llm'].includes(api.provider.type) && (
              <>
                <label>
                  {t('接口地址')}
                  <input
                    value={api.provider.url}
                    onChange={(e) => api.patch({ url: e.target.value })}
                  />
                </label>
                {api.provider.type === 'llm' && (
                  <label>
                    {t('模型')}
                    <input
                      value={api.provider.model}
                      onChange={(e) => api.patch({ model: e.target.value })}
                    />
                  </label>
                )}
                <label>
                  API Key
                  <input
                    type="password"
                    autoComplete="off"
                    value={api.provider.key}
                    onChange={(e) => api.patch({ key: e.target.value })}
                  />
                </label>
                <ProviderAdvanced feature="ocr" {...api} />
              </>
            )}
          </details>
        </fieldset>
        <p className="muted">
          {t(
            '只保存文字与位置，不修改图片。支持行级高亮；无坐标的结果高亮整张图片。结果保存在 .tixtab 工程中。',
          )}
        </p>
        <p role="status">
          {status || t('默认跳过已识别的位图')} {busy && t('已识别 {0} 张', count)}
        </p>
        <footer>
          {busy ? (
            <button onClick={() => controller.current?.abort()}>{t('停止')}</button>
          ) : (
            <button
              className="primary"
              disabled={!api.ready || !indices.length || api.provider.type === 'texo'}
              onClick={() => void start()}
            >
              {t('开始解析')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
