import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Notebook } from './model';
import { X, Download } from 'lucide-react';
import { t, useLocale } from './i18n';
import { scopePages } from './pageOperations';
import { chooseImageDirectory, exportBitmapImages, type ImageExportProgress } from './imageExport';
export default function ImageExportDialog({
  notebook,
  pdf,
  index,
  onClose,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  onClose: () => void;
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
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const close = () => {
    controller.current?.abort();
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
      className="modal-scrim"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
      }}
    >
      <section
        className="modal image-export-modal"
        role="dialog"
        aria-modal="true"
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
            <button className="primary" onClick={() => void start()}>
              <Download size={16} />
              {t('选择目录并提取')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
