import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ScanText } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Page } from './model';
import { t, useLocale } from './i18n';
import { parsePageRange } from './pdfInsertion';
import { inspectBitmapPages, scanBitmapPages, type BitmapInventory } from './bitmapOcr';
import { executeProvider, providerFailureStatus, withBitmapOcrPool } from './providers';
import { useProviderConfig } from './providerSettings';
import { loadOcrDevice } from './nativeOcr';
import { ProviderAdvanced } from './ProviderAdvanced';
import './bitmapOcr.css';
function preferredBackend() {
  try {
    const type = localStorage.getItem('tixtab.bitmapOcrProvider');
    if (type && ['local', 'native', 'web', 'llm'].includes(type)) return type;
  } catch {
    /* Default remains available without storage. */
  }
  return 'local';
}
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
  const api = useProviderConfig('ocr', 'local');
  const [initialBackend] = useState(preferredBackend);
  const [concurrency, setConcurrency] = useState(() => {
    try {
      const n = Number(localStorage.getItem('tixtab.bitmapOcrConcurrency'));
      return [1, 2, 4].includes(n) ? n : 1;
    } catch {
      return 1;
    }
  });
  const initialized = useRef(false);
  const [range, setRange] = useState(''),
    [all, setAll] = useState(true),
    [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [count, setCount] = useState(0),
    [runTotal, setRunTotal] = useState<number | null>(null),
    [inventory, setInventory] = useState<BitmapInventory | null>(null),
    [counts, setCounts] = useState({ total: 0, parsed: 0 });
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
  const indices = useMemo(() => {
    try {
      if (!all && !range.trim()) return [];
      return parsePageRange(all ? '' : range, pages.length);
    } catch {
      return [];
    }
  }, [all, range, pages.length]);
  useEffect(() => {
    if (api.ready && !initialized.current) {
      initialized.current = true;
      api.selectProvider(initialBackend);
    }
  }, [api.ready]);
  const scope = indices.join(',');
  useEffect(() => {
    const abort = new AbortController();
    setInventory(null);
    setCounts({ total: 0, parsed: 0 });
    if (scope)
      void inspectBitmapPages(
        scope.split(',').map((i) => pages[Number(i)]),
        pdf,
        abort.signal,
      )
        .then((value) => {
          if (!abort.signal.aborted) {
            setInventory(value);
            setCounts({ total: value.total, parsed: value.parsed });
          }
        })
        .catch((error) => {
          if (!abort.signal.aborted) setStatus(providerFailureStatus(error, false));
        });
    return () => abort.abort();
  }, [scope, pages, pdf]);
  useEffect(() => {
    setRunTotal(null);
    setCount(0);
    setStatus('');
  }, [scope]);
  const start = async () => {
    if (busy || controller.current || !indices.length || !inventory) return;
    const abort = new AbortController();
    controller.current = abort;
    const completed = new Map<string, Page>();
    let images = 0;
    setBusy(true);
    setCount(0);
    setRunTotal(replace ? inventory.total : inventory.total - inventory.parsed);
    setStatus(t('正在解析位图…'));
    try {
      const scan = (
        recognize?: (
          image: string,
          lane: number,
        ) => Promise<import('./bitmapOcr').BitmapRecognition>,
      ) =>
        scanBitmapPages(
          indices.map((i) => pages[i]),
          pdf,
          {
            signal: abort.signal,
            replace,
            inventory,
            concurrency: api.provider.type === 'local' ? concurrency : 1,
            onPage: (p) => completed.set(p.id, p),
            onImage: (alreadyParsed) => {
              if (alive.current) {
                setCount(++images);
                setCounts((previous) => ({
                  ...previous,
                  parsed: previous.parsed + (alreadyParsed ? 0 : 1),
                }));
                if (images === 1) setStatus(t('正在解析位图…'));
              }
            },
            recognize:
              recognize ??
              (async (image) => {
                if (images === 0 && alive.current)
                  setStatus(
                    t(
                      ['native', 'local'].includes(api.provider.type)
                        ? '正在准备本地模型并识别首张位图…'
                        : '正在识别首张位图…',
                    ),
                  );
                return executeProvider(
                  {
                    feature: 'ocr',
                    input: image,
                    ocrLayout: true,
                    config: api.provider,
                    device: loadOcrDevice(),
                    localPreference: 'local',
                  },
                  {
                    signal: abort.signal,
                  },
                );
              }),
          },
        );
      if (api.provider.type === 'local') {
        setStatus(t('正在准备本地模型并识别首张位图…'));
        await withBitmapOcrPool(concurrency, abort.signal, scan);
      } else await scan();
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
        <div className="bitmap-ocr-progress">
          <progress
            aria-label={t('位图解析进度')}
            max={Math.max(1, runTotal ?? counts.total)}
            value={inventory ? (runTotal === null ? counts.parsed : count) : undefined}
          />
          <div className="bitmap-ocr-counts">
            <span>
              {inventory
                ? t(
                    '已解析 {0} 张 · 未解析 {1} 张',
                    counts.parsed,
                    Math.max(0, counts.total - counts.parsed),
                  )
                : t('正在统计位图…')}
            </span>
            {runTotal !== null && (
              <span>
                {count} / {runTotal}
              </span>
            )}
          </div>
        </div>
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
              onChange={(e) => {
                api.selectProvider(e.target.value);
                try {
                  localStorage.setItem('tixtab.bitmapOcrProvider', e.target.value);
                } catch {
                  /* Session choice. */
                }
              }}
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
            <label>
              {t('并行任务数')}
              <select
                aria-label={t('并行任务数')}
                disabled={api.provider.type !== 'local'}
                value={concurrency}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setConcurrency(n);
                  try {
                    localStorage.setItem('tixtab.bitmapOcrConcurrency', String(n));
                  } catch {}
                }}
              >
                {[1, 2, 4].map((n) => (
                  <option value={n} key={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {t('Tesseract 支持并行识别；增加任务数会占用更多内存。其它后端保持串行。')}
            </p>
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
        <p role="status">{status || t('默认跳过已识别的位图')}</p>
        <footer>
          {busy ? (
            <button onClick={() => controller.current?.abort()}>{t('停止')}</button>
          ) : (
            <button
              className="primary"
              disabled={!api.ready || !indices.length || !inventory || api.provider.type === 'texo'}
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
