import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from './pdfTypes';
import type { Notebook } from './model';
import { X, Download } from 'lucide-react';
import { t, useLocale } from './i18n';
import { scopePages } from './pageOperations';
import { chooseImageDirectory, exportBitmapImages, type ImageExportProgress } from './imageExport';
import { inspectBitmapPages } from './bitmapOcr';
import { useBackgroundPanel } from './useBackgroundPanel';
export default function ImageExportDialog({
  notebook,
  pdf,
  index,
  onClose,
  onVisibility,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  onClose: () => void;
  onVisibility?: (hidden: boolean) => void;
}) {
  useLocale();
  const [scope, setScope] = useState('current'),
    [range, setRange] = useState(''),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [destination, setDestination] = useState(''),
    [progress, setProgress] = useState<ImageExportProgress | null>(null);
  const controller = useRef<AbortController | null>(null),
    alive = useRef(true);
  const [count, setCount] = useState<{ total: number | null; error: string }>({
    total: null,
    error: '',
  });
  const [countRetry, setCountRetry] = useState(0);
  const panel = useBackgroundPanel({
    title: t('提取图片'),
    busy,
    status,
    done: progress ? progress.saved + progress.skipped : 0,
    total: progress?.total,
    cancel: () => controller.current?.abort(),
    onClose,
    onVisibility,
  });
  useEffect(() => {
    const abort = new AbortController();
    setCount({ total: null, error: '' });
    setProgress(null);
    setStatus('');
    const timer = setTimeout(
      () => {
        void (async () => {
          const selected = scopePages(scope, range, index, notebook.pages.length).map(
            (i) => notebook.pages[i],
          );
          const inventory = await inspectBitmapPages(selected, pdf, abort.signal);
          const total = inventory.total;
          inventory.pdfImages.clear();
          if (!abort.signal.aborted) setCount({ total, error: '' });
        })().catch((error) => {
          if (!abort.signal.aborted)
            setCount({
              total: null,
              error:
                error instanceof Error && error.message === 'page-range'
                  ? '页码范围无效。'
                  : '位图索引读取失败，请重试。',
            });
        });
      },
      scope === 'range' ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [scope, range, index, notebook.pages, pdf, countRetry]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const close = () => {
    if (controller.current) {
      panel.hide();
      return;
    }
    onClose();
  };
  const start = async () => {
    if (controller.current) return;
    const owner = new AbortController();
    controller.current = owner;
    setBusy(true);
    setProgress(null);
    let sink: Awaited<ReturnType<typeof chooseImageDirectory>> = null;
    try {
      const indices = scopePages(scope, range, index, notebook.pages.length);
      sink = await chooseImageDirectory();
      owner.signal.throwIfAborted();
      if (!sink) return;
      if (alive.current) {
        setDestination(sink.directory);
        setStatus(t('正在读取位图索引…'));
      }
      await exportBitmapImages(notebook.pages, pdf, indices, sink, owner.signal, (p) => {
        if (alive.current) {
          setProgress(p);
          setStatus(t('正在提取图片…'));
        }
      });
      sink = null;
      if (alive.current) setStatus(t('图片提取完成。'));
    } catch (e) {
      if (alive.current)
        setStatus(
          owner.signal.aborted
            ? t('已停止，已保存的图片会保留。')
            : t(
                e instanceof Error && e.message === 'page-range'
                  ? '页码范围无效。'
                  : '图片提取失败，请检查目录权限后重试。',
              ),
        );
    } finally {
      await sink?.close().catch(() => {});
      if (controller.current === owner) controller.current = null;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div
      className={`modal-scrim${panel.hidden ? ' background-hidden' : ''}`}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
      }}
    >
      <section
        className="modal image-export-modal"
        role="dialog"
        aria-modal={panel.hidden ? undefined : true}
        aria-label={t('提取图片')}
      >
        <header>
          <h2>{t('提取图片')}</h2>
          <button className="icon-button" aria-label={t('关闭')} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div className="image-export-body">
          <label>
            {t('页面范围')}
            <select
              aria-label={t('页面范围')}
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="current">{t('当前页')}</option>
              <option value="all">{t('全文')}</option>
              <option value="range">{t('指定页')}</option>
            </select>
          </label>
          {scope === 'range' && (
            <input
              aria-label={t('指定页码')}
              placeholder="1-3, 5"
              value={range}
              disabled={busy}
              onChange={(e) => setRange(e.target.value)}
            />
          )}
          <p className="muted" aria-live="polite" aria-label={t('范围内位图数量')}>
            {count.error
              ? t(count.error)
              : count.total === null
                ? t('正在统计位图…')
                : t('范围内位图：{0}', count.total)}
            {count.error && (
              <button type="button" onClick={() => setCountRetry((n) => n + 1)}>
                {t('重试')}
              </button>
            )}
          </p>
          <p className="muted">
            {t('按原色逐张保存为 PNG，包含插入的位图。超过 6400 万像素或不支持的图片会跳过。')}
          </p>
          {destination && (
            <p className="image-export-directory" title={destination}>
              {destination}
            </p>
          )}
          {progress && (
            <>
              <progress
                max={Math.max(1, progress.total)}
                value={progress.saved + progress.skipped}
              />
              <p>
                {t('已保存 {0} / {1}，跳过 {2}', progress.saved, progress.total, progress.skipped)}
              </p>
            </>
          )}
          <p role="status">{status}</p>
        </div>
        <footer>
          {busy ? (
            <button onClick={() => controller.current?.abort()}>{t('停止')}</button>
          ) : (
            <button
              className="primary"
              disabled={count.total === null || count.total === 0}
              onClick={() => void start()}
            >
              <Download size={16} />
              {t('选择目录并提取')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
