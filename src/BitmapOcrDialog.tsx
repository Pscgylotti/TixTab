import WindowsAiOcrSettings from './WindowsAiOcrSettings';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ScanText } from 'lucide-react';
import type { PDFDocumentProxy } from './pdfTypes';
import type { Page } from './model';
import { t, useLocale } from './i18n';
import { parsePageRange } from './pdfInsertion';
import { inspectBitmapPages, scanBitmapPages, type BitmapInventory } from './bitmapOcr';
import {
  executeProvider,
  providerFailureStatus,
  withBitmapOcrPool,
  withBitmapNpuOcr,
  withBitmapNativeCppOcr,
  withBitmapWindowsAiOcr,
} from './providers';
import { useProviderConfig } from './providerSettings';
import { loadOcrDevice } from './nativeOcr';
import { ProviderAdvanced } from './ProviderAdvanced';
import NativeCppOcrSettings from './NativeCppOcrSettings';
import { nativeCppVariant } from './nativeCppOcr';
import './bitmapOcr.css';
const emptyTiming = { totalMs: 0, layoutMs: 0, inferenceMs: 0, compileMs: 0, serviceMs: 0 };
function preferredBackend() {
  try {
    const type = localStorage.getItem('tixtab.bitmapOcrProvider');
    if (
      type &&
      ['local', 'native', 'windows-ai', 'tesseract-native', 'web', 'llm', 'tesseract-npu'].includes(
        type,
      )
    )
      return type;
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
  const [npu, setNpu] = useState(initialBackend === 'tesseract-npu');
  const [variant, setVariant] = useState<import('./nativeTesseract').TesseractVariant>(() => {
    try {
      const saved = localStorage.getItem('tixtab.bitmapOcrNpuVariant');
      return saved === 'fast' || saved === 'mixed-best' ? saved : 'best';
    } catch {
      return 'best';
    }
  });
  const [concurrency, setConcurrency] = useState(() => {
    try {
      const n = Number(localStorage.getItem('tixtab.bitmapOcrConcurrency'));
      return [1, 2, 4].includes(n) ? n : 1;
    } catch {
      return 1;
    }
  });
  const [timing, setTiming] = useState(emptyTiming);
  const nativeNpu =
    !npu &&
    api.provider.type === 'tesseract-native' &&
    nativeCppVariant(api.provider.model).startsWith('npu-');
  const initialized = useRef(false);
  const [range, setRange] = useState(''),
    [all, setAll] = useState(true),
    [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false),
    [stopping, setStopping] = useState(false),
    [status, setStatus] = useState(''),
    [count, setCount] = useState(0),
    [runTotal, setRunTotal] = useState<number | null>(null),
    [inventory, setInventory] = useState<BitmapInventory | null>(null),
    [counts, setCounts] = useState({ total: 0, parsed: 0 });
  const controller = useRef<AbortController | null>(null),
    alive = useRef(true),
    closing = useRef(false);
  const stop = () => {
    if (!controller.current || controller.current.signal.aborted) return;
    setStopping(true);
    setStatus(t('正在停止并保留已完成结果…'));
    controller.current.abort();
  };
  const close = () => {
    if (controller.current) {
      closing.current = true;
      stop();
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
      if (initialBackend !== 'tesseract-npu') api.selectProvider(initialBackend);
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
    setTiming(emptyTiming);
    setStatus('');
  }, [scope]);
  const start = async () => {
    if (busy || controller.current || !indices.length || !inventory) return;
    const abort = new AbortController();
    controller.current = abort;
    const completed = new Map<string, Page>();
    let images = 0;
    setBusy(true);
    setTiming(emptyTiming);
    setStopping(false);
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
            concurrency:
              !npu && !nativeNpu && ['local', 'tesseract-native'].includes(api.provider.type)
                ? concurrency
                : 1,
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
            recognize: async (image, lane) => {
              const started = performance.now();
              if (images === 0 && alive.current)
                setStatus(
                  t(
                    npu || ['native', 'local', 'tesseract-native'].includes(api.provider.type)
                      ? '正在准备本地模型并识别首张位图…'
                      : '正在识别首张位图…',
                  ),
                );
              const result: import('./bitmapOcr').BitmapRecognition = recognize
                ? await recognize(image, lane)
                : await executeProvider(
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
              abort.signal.throwIfAborted();
              if (alive.current)
                setTiming((previous) => ({
                  totalMs: previous.totalMs + performance.now() - started,
                  layoutMs: previous.layoutMs + (result.timing?.layoutMs ?? 0),
                  inferenceMs: previous.inferenceMs + (result.timing?.inferenceMs ?? 0),
                  compileMs: previous.compileMs + (result.timing?.compileMs ?? 0),
                  serviceMs: previous.serviceMs + (result.timing?.serviceMs ?? 0),
                }));
              return result;
            },
          },
        );
      if (npu) {
        setStatus(t('正在准备本地模型并识别首张位图…'));
        await withBitmapNpuOcr(
          variant,
          variant === 'mixed-best' ? 1 : concurrency,
          abort.signal,
          scan,
        );
      } else if (api.provider.type === 'windows-ai') {
        setStatus(t('正在准备 Windows AI OCR 系统模型…'));
        await withBitmapWindowsAiOcr(abort.signal, scan);
      } else if (api.provider.type === 'tesseract-native') {
        await withBitmapNativeCppOcr(
          nativeCppVariant(api.provider.model),
          nativeCppVariant(api.provider.model).startsWith('npu-') ? 1 : concurrency,
          abort.signal,
          scan,
        );
      } else if (api.provider.type === 'local') {
        setStatus(t('正在准备本地模型并识别首张位图…'));
        await withBitmapOcrPool(concurrency, abort.signal, scan);
      } else await scan();
      if (alive.current) setStatus(t('解析完成：{0} 张位图，可在全文搜索中检索', images));
    } catch (error) {
      if (alive.current)
        setStatus(
          abort.signal.aborted
            ? t('已停止，保留已完成的识别结果')
            : providerFailureStatus(error, !npu && ['web', 'llm'].includes(api.provider.type)),
        );
    } finally {
      if (alive.current) {
        if (completed.size) onApply([...completed.values()]);
        setBusy(false);
        setStopping(false);
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
              value={npu ? 'tesseract-npu' : api.provider.type}
              onChange={(e) => {
                setNpu(e.target.value === 'tesseract-npu');
                if (e.target.value !== 'tesseract-npu') api.selectProvider(e.target.value);
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
              <option value="windows-ai" disabled={!window.surfaceDesktop?.windowsAiOcr}>
                Windows AI OCR · NPU
              </option>
              <option value="tesseract-native" disabled={!window.surfaceDesktop?.nativeOcr}>
                Tesseract · C++
              </option>
              <option value="tesseract-npu">Tesseract · NPU · {t('实验性')}</option>
              <option value="web">HTTP OCR API</option>
              <option value="llm">LLM API</option>
            </select>
          </label>
          {!npu && api.provider.type === 'windows-ai' && <WindowsAiOcrSettings disabled={busy} />}
          {!npu && api.provider.type === 'tesseract-native' && (
            <NativeCppOcrSettings
              value={api.provider.model}
              onChange={(model) => api.patch({ model })}
            />
          )}
          {npu && (
            <>
              <label>
                {t('模型')}
                <select
                  aria-label={t('NPU Tesseract 模型')}
                  value={variant}
                  onChange={(e) => {
                    const next =
                      e.target.value === 'fast' || e.target.value === 'mixed-best'
                        ? e.target.value
                        : 'best';
                    setVariant(next);
                    try {
                      localStorage.setItem('tixtab.bitmapOcrNpuVariant', next);
                    } catch {}
                  }}
                >
                  <option value="best">English · Best</option>
                  <option value="fast">English · Fast</option>
                  <option value="mixed-best">{t('简体中文 + English · 混合 Best')}</option>
                </select>
              </label>
              <p className="muted">
                {t(
                  variant === 'mixed-best'
                    ? '简体中文与英文混排，使用单个中文 Best 网络。需安装 Tesseract 中英混合 Best。暂固定单行 NPU 推理。实验性，字符与空格可能有误，请核对；NPU 不保证更快。'
                    : '仅支持英文。CPU 分行，NPU 识别；队列上限 16 行。长行使用 NPU 单行推理。实验性结果可能存在字符与空格偏差，请核对。需在本地模型管理中安装 Tesseract English Fast + Best 与本地加速运行时。',
                )}
              </p>
            </>
          )}
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
              {t(npu ? '最大识别批量' : '并行任务数')}
              <select
                aria-label={t(npu ? '最大识别批量' : '并行任务数')}
                disabled={
                  nativeNpu ||
                  (npu && variant === 'mixed-best') ||
                  (!npu && !['local', 'tesseract-native'].includes(api.provider.type))
                }
                value={
                  nativeNpu ||
                  (npu && variant === 'mixed-best') ||
                  (!npu && !['local', 'tesseract-native'].includes(api.provider.type))
                    ? 1
                    : concurrency
                }
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
            {!npu && (
              <p className="muted">
                {t(
                  'Tesseract 按最大任务数并行识别；大图受 400 万输入像素总预算限制，自动减少同时识别数量。其它后端保持串行。',
                )}
              </p>
            )}
            {!npu && ['web', 'llm'].includes(api.provider.type) && (
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
        {timing.totalMs > 0 && (
          <details className="native-settings">
            <summary>{t('耗时详情')}</summary>
            <p>{t('识别任务累计耗时：{0} 秒', (timing.totalMs / 1000).toFixed(2))}</p>
            {(npu || nativeNpu) && (
              <>
                <p>
                  {t(
                    'CPU 分行：{0} 秒 · NPU 推理：{1} 秒',
                    (timing.layoutMs / 1000).toFixed(2),
                    (timing.inferenceMs / 1000).toFixed(2),
                  )}
                </p>
                <p>
                  {t(
                    '本次编译：{0} 秒 · 服务处理：{1} 秒',
                    (timing.compileMs / 1000).toFixed(2),
                    (timing.serviceMs / 1000).toFixed(2),
                  )}
                </p>
              </>
            )}
            <p className="muted">
              {t('累计任务耗时包含等待与传输，可能重叠，不等同整批实际耗时。')}
            </p>
          </details>
        )}
        <footer>
          {busy ? (
            <button disabled={stopping} onClick={stop}>
              {t(stopping ? '正在停止…' : '停止')}
            </button>
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
