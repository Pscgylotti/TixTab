import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCw, RotateCcw, Crop, Scissors, Undo2 } from 'lucide-react';
import type { PDFDocumentProxy } from './pdfTypes';
import PageThumbnail from './PageThumbnail';
import RegionCapture from './RegionCapture';
import type { Notebook } from './model';
import { scopePages, type PageAction, type CropMargins } from './pageOperations';
import { editPages } from './pageOperationsClient';
import { exportPdf } from './pdf';
import { download } from './storage';
import { splitPdfZip } from './splitPdfClient';
import { t, useLocale } from './i18n';
import { pdfEditErrors } from './pdfNativeTypes';
import './pageEditing.css';
export default function PageOperationsDialog({
  notebook,
  pdf,
  index,
  action,
  onApply,
  onClose,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  action: PageAction;
  onApply: (next: Notebook) => void;
  onClose: () => void;
}) {
  useLocale();
  const [scope, setScope] = useState('current'),
    [range, setRange] = useState(''),
    [angle, setAngle] = useState(0);
  const [picking, setPicking] = useState(false);
  const [margins, setMargins] = useState<CropMargins>({ left: 0, right: 0, top: 0, bottom: 0 });
  const [split, setSplit] = useState('selected'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [progress, setProgress] = useState('');
  const controller = useRef<AbortController | null>(null),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      controller.current?.abort();
    },
    [],
  );
  async function apply() {
    if (controller.current) return;
    if (action === 'rotate' && angle === 0) return;
    const job = new AbortController();
    controller.current = job;
    setBusy(true);
    setError('');
    setProgress('');
    try {
      const indices = scopePages(scope, range, index, notebook.pages.length);
      if (action === 'split') {
        const ids = new Set(indices.map((i) => notebook.pages[i].id));
        const selection = {
          ...notebook,
          pages: indices.map((i) => notebook.pages[i]),
          bookmarks: notebook.bookmarks?.filter((b) => ids.has(b.pageId)),
        };
        const bytes = await exportPdf(selection, { signal: job.signal });
        job.signal.throwIfAborted();
        if (split === 'each') {
          const zip = await splitPdfZip(bytes, notebook.name, job.signal, (done, total) => {
            if (alive.current) setProgress(t('正在拆分 {0} / {1}', done, total));
          });
          job.signal.throwIfAborted();
          download(zip, `${notebook.name}-pages.zip`, 'application/zip');
        } else download(bytes, `${notebook.name}-extract.pdf`, 'application/pdf');
        onClose();
      } else {
        const next = await editPages(
          notebook,
          indices,
          action === 'rotate' ? { action, angle: angle as 90 | 180 | 270 } : { action, margins },
          job.signal,
        );
        if (alive.current) onApply(next);
      }
    } catch (e) {
      if (alive.current && !job.signal.aborted)
        setError(e instanceof Error ? e.message : 'page-edit');
    } finally {
      controller.current = null;
      if (alive.current) setBusy(false);
    }
  }
  const title =
    action === 'rotate' ? '旋转页面' : action === 'crop' ? '裁剪页面' : '拆分 / 提取 PDF';
  const Icon = action === 'rotate' ? RotateCw : action === 'crop' ? Crop : Scissors;
  if (picking) {
    const host = document.querySelector('.canvas-container');
    if (host)
      return createPortal(
        <RegionCapture
          label={t('框选裁剪区域')}
          hint={t('拖动框选要保留的页面区域')}
          targetPageId={notebook.pages[index].id}
          onClose={() => setPicking(false)}
          onCapture={(_, region) => {
            const page = notebook.pages[index];
            const percent = (value: number, size: number) =>
              Math.round(Math.max(0, (value / size) * 100) * 100) / 100;
            setMargins({
              left: percent(region.x, page.width),
              top: percent(region.y, page.height),
              right: percent(page.width - region.x - region.width, page.width),
              bottom: percent(page.height - region.y - region.height, page.height),
            });
            setPicking(false);
          }}
        />,
        host,
      );
  }
  return (
    <div
      className="modal-scrim"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <section className="editing-dialog" role="dialog" aria-modal="true" aria-label={t(title)}>
        <header>
          <Icon size={18} />
          <h2>{t(title)}</h2>
          <button aria-label={t('关闭')} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="editing-fields">
          <label>
            {t('作用范围')}
            <select value={scope} disabled={busy} onChange={(e) => setScope(e.target.value)}>
              <option value="current">{t('当前页（第 {0} 页）', index + 1)}</option>
              <option value="all">{t('全文')}</option>
              <option value="range">{t('指定页面')}</option>
            </select>
          </label>
          {scope === 'range' && (
            <label>
              {t('页码范围')}
              <input
                value={range}
                maxLength={2048}
                placeholder="1-3, 5"
                onChange={(e) => setRange(e.target.value)}
                disabled={busy}
              />
            </label>
          )}
          {action === 'rotate' && (
            <>
              <div className="page-rotate-actions">
                <button disabled={busy} onClick={() => setAngle((a) => (a + 270) % 360)}>
                  <RotateCcw size={18} />
                  {t('逆时针 90°')}
                </button>
                <button disabled={busy} onClick={() => setAngle((a) => (a + 90) % 360)}>
                  <RotateCw size={18} />
                  {t('顺时针 90°')}
                </button>
                <button
                  disabled={busy || !angle}
                  aria-label={t('重置旋转')}
                  title={t('重置旋转')}
                  onClick={() => setAngle(0)}
                >
                  <Undo2 size={16} />
                </button>
              </div>
              <PageEditPreview notebook={notebook} pdf={pdf} index={index} angle={angle} />
            </>
          )}
          {action === 'crop' && (
            <>
              <button disabled={busy} onClick={() => setPicking(true)}>
                <Crop size={17} />
                {t('在页面上框选裁剪区域')}
              </button>
              <div className="field-row">
                {(['left', 'right', 'top', 'bottom'] as const).map((k) => (
                  <label key={k}>
                    {t(
                      {
                        left: '左侧裁剪 (%)',
                        right: '右侧裁剪 (%)',
                        top: '上方裁剪 (%)',
                        bottom: '下方裁剪 (%)',
                      }[k],
                    )}
                    <input
                      type="number"
                      step="0.5"
                      min={0}
                      max={99}
                      value={margins[k]}
                      disabled={busy}
                      onChange={(e) => setMargins({ ...margins, [k]: e.target.valueAsNumber })}
                    />
                  </label>
                ))}
              </div>
              <p>
                {t('按各页当前可见尺寸的百分比裁剪，兼容不同纸张尺寸；边界外内容仍保留在 PDF 中。')}
              </p>
              <PageEditPreview notebook={notebook} pdf={pdf} index={index} margins={margins} />
            </>
          )}
          {action === 'split' && (
            <>
              <label>
                {t('拆分方式')}
                <select value={split} disabled={busy} onChange={(e) => setSplit(e.target.value)}>
                  <option value="selected">{t('所选页面组成一个 PDF')}</option>
                  <option value="each">{t('每页一个 PDF（ZIP）')}</option>
                </select>
              </label>
              <p>
                {t(
                  '导出包含笔迹、对象和便签；原工程保留。逐页拆分会将表单外观固定，并移除指向其它页的链接。',
                )}
              </p>
            </>
          )}
          {busy && (
            <>
              <progress />
              <span role="status">{progress || t('正在处理页面…')}</span>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {t(
                pdfEditErrors[error] ||
                  (error === 'split-large'
                    ? '拆分结果超过 256 MB，请缩小页码范围。'
                    : error === 'split-failed'
                      ? '拆分失败，请尝试提取所选页面。'
                      : error),
              )}
            </p>
          )}
        </div>
        <footer>
          {busy ? (
            <button onClick={() => controller.current?.abort()}>{t('取消任务')}</button>
          ) : (
            <button
              className="primary"
              disabled={action === 'rotate' && !angle}
              onClick={() => void apply()}
            >
              {t(action === 'split' ? '导出' : '应用修改')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
function PageEditPreview({
  notebook,
  pdf,
  index,
  margins,
  angle = 0,
}: {
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  margins?: CropMargins;
  angle?: number;
}) {
  const p = notebook.pages[index];
  const scale = Math.min(200 / p.width, 200 / p.height),
    w = p.width * scale,
    h = p.height * scale;
  const safe = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(99, v)) : 0);
  const m = margins && {
    left: safe(margins.left),
    right: safe(margins.right),
    top: safe(margins.top),
    bottom: safe(margins.bottom),
  };
  return (
    <div className="page-edit-previews" aria-label={t(m ? '裁剪边界预览' : '旋转预览')}>
      <div className="page-edit-preview-stage">
        <div
          style={{ width: w, height: h, transform: `rotate(${angle}deg)` }}
          className="page-edit-preview-paper"
        >
          <PageThumbnail page={p} pdf={pdf} />
          {m && (
            <div
              className="crop-preview-region"
              style={{
                left: `${m.left}%`,
                top: `${m.top}%`,
                right: `${m.right}%`,
                bottom: `${m.bottom}%`,
              }}
            />
          )}
        </div>
      </div>
      {m && (
        <div className="page-edit-preview-stage">
          <div
            className="crop-result-preview"
            aria-label={t('裁剪结果预览')}
            style={{
              width: Math.max(1, (w * (100 - m.left - m.right)) / 100),
              height: Math.max(1, (h * (100 - m.top - m.bottom)) / 100),
            }}
          >
            <div
              className="page-edit-preview-paper"
              style={{
                position: 'absolute',
                width: w,
                height: h,
                left: (-w * m.left) / 100,
                top: (-h * m.top) / 100,
              }}
            >
              <PageThumbnail page={p} pdf={pdf} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
