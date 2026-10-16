import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { t } from './i18n';
import type { Notebook, Page } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import { scopePages } from './pageOperations';
import { capturePage } from './capturePage';
import LocalToolSetup from './LocalToolSetup';
import { useRuntimeClose } from './useRuntimeClose';
import {
  correctionTargets,
  correctTarget,
  applyCorrection,
  type CorrectionTarget,
} from './documentCorrection';
import { runLocalDocumentTool, localToolErrors, type LocalToolEngine } from './localDocumentTools';
import { parseMusicScore, remapScoreSystems } from './musicScore';
import { setLocalImagePicker, pickLocalImage } from './localImagePicker';
import './localDocumentTools.css';
import { useBackgroundPanel } from './useBackgroundPanel';
export default function LocalDocumentToolDialog({
  kind,
  notebook,
  pdf,
  index,
  onApply,
  onClose,
  onRecognized,
  onVisibility,
}: {
  kind: 'correct' | 'music';
  notebook: Notebook;
  pdf: PDFDocumentProxy | null;
  index: number;
  onApply: (pages: Page[], bases: Page[], origin: Notebook) => void | Promise<void>;
  onClose: () => void;
  onRecognized: () => void;
  onVisibility?: (hidden: boolean) => void;
}) {
  const [engine, setEngine] = useState<LocalToolEngine>(kind === 'correct' ? 'uvdoc' : 'audiveris'),
    [scope, setScope] = useState('current'),
    [range, setRange] = useState(''),
    [mode, setMode] = useState<'auto' | 'scan' | 'photo'>('auto'),
    [device, setDevice] = useState<'AUTO' | 'CPU' | 'GPU' | 'NPU'>('AUTO'),
    [scanOnly, setScanOnly] = useState(true);
  const [busy, setBusy] = useState(false),
    [settingUp, setSettingUp] = useState(false),
    [status, setStatus] = useState(''),
    [logs, setLogs] = useState(''),
    [progress, setProgress] = useState({ done: 0, total: 0 }),
    [picking, setPicking] = useState(false),
    [picked, setPicked] = useState<CorrectionTarget | null>(null);
  const [preview, setPreview] = useState<{
    original: string;
    image: string;
    model: string;
    target: CorrectionTarget;
    page: Page;
    device?: string;
  } | null>(null);
  const controller = useRef<AbortController | null>(null),
    setupCancel = useRef<(() => void) | null>(null),
    alive = useRef(true),
    current = useRef(notebook);
  current.current = notebook;
  const closeNow = () => {
    controller.current?.abort();
    setLocalImagePicker(null);
    onClose();
  };
  const panel = useBackgroundPanel({
    title: t(kind === 'correct' ? '文档矫正' : '五线谱识别'),
    busy: busy || settingUp,
    status,
    done: progress.done,
    total: progress.total,
    cancel: () => {
      controller.current?.abort();
      setupCancel.current?.();
    },
    onClose,
    onVisibility,
  });
  const { close, confirmation } = useRuntimeClose(
    () => (busy || settingUp ? panel.hide() : closeNow()),
    undefined,
    panel.hide,
  );
  const hidden = useRef(panel.hidden);
  hidden.current = panel.hidden;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      setLocalImagePicker(null);
    };
  }, []);
  useEffect(() => {
    if (!picking) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        pickLocalImage(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [picking]);
  const start = async (previewOnly = false) => {
    if (controller.current || settingUp) return;
    const origin = current.current;
    const a = new AbortController();
    controller.current = a;
    setBusy(true);
    setLogs('');
    setStatus(t(kind === 'correct' ? '正在统计位图索引…' : '正在识别五线谱…'));
    setProgress({ done: 0, total: 0 });
    setPreview(null);
    let failures = 0,
      completed = 0;
    try {
      const selected =
        scope === 'picked' && picked
          ? [current.current.pages.find((p) => p.id === picked.pageId)!]
          : scopePages(scope, range, index, current.current.pages.length).map(
              (i) => current.current.pages[i],
            );
      if (kind === 'correct') {
        const targets =
          scope === 'picked' && picked
            ? [picked]
            : await correctionTargets(selected, pdf, scanOnly, a.signal);
        setProgress({ done: 0, total: previewOnly ? Math.min(1, targets.length) : targets.length });
        if (!targets.length) {
          setStatus(t('范围内没有符合条件的位图。'));
          return;
        }
        for (const target of previewOnly ? targets.slice(0, 1) : targets) {
          a.signal.throwIfAborted();
          const page =
            current.current.pages.find((p) => p.id === target.pageId) ??
            origin.pages.find((p) => p.id === target.pageId);
          if (!page) continue;
          setStatus(t('正在矫正文档…'));
          const result = await correctTarget(page, target, pdf, mode, device, a.signal);
          a.signal.throwIfAborted();
          if (previewOnly) {
            setPreview({ ...result, target, page });
            setStatus(t('预览已生成，确认后应用。'));
          } else {
            const latest = current.current.pages.find((p) => p.id === target.pageId) ?? page;
            await onApply(
              [await applyCorrection(latest, target, result.image, result.model, a.signal)],
              [latest],
              origin,
            );
            completed++;
            setProgress((p) => ({ ...p, done: completed }));
          }
        }
      } else {
        setProgress({ done: 0, total: selected.length });
        for (const page of selected) {
          a.signal.throwIfAborted();
          try {
            const image = await capturePage(
              page,
              pdf,
              { x: 0, y: 0, width: page.width, height: page.height },
              { ink: false },
            );
            a.signal.throwIfAborted();
            const result = await runLocalDocumentTool(
              { action: 'recognize', engine, image },
              a.signal,
            );
            if (!result?.musicxml) throw Error('no-score');
            let score = parseMusicScore(
              result.musicxml,
              engine === 'homr' ? 'homr' : 'audiveris',
              result.noteLocations
                ? { systems: result.systems ?? [], noteLocations: result.noteLocations }
                : undefined,
            );
            if (!result.noteLocations && result.systems?.length)
              score = remapScoreSystems(score, result.systems);
            a.signal.throwIfAborted();
            const latest = current.current.pages.find((p) => p.id === page.id) ?? page;
            await onApply([{ ...latest, score }], [latest], origin);
            completed++;
          } catch (e) {
            if (a.signal.aborted) throw e;
            if ((e as Error).message === 'no-score') failures++;
            else throw e;
          }
          setProgress((p) => ({ ...p, done: completed + failures }));
        }
        if (completed && !hidden.current) onRecognized();
      }
      if (!previewOnly) setStatus(t('已完成 {0} 项，未识别 {1} 项。', completed, failures));
    } catch (e) {
      if (alive.current) {
        setStatus(
          t(
            a.signal.aborted
              ? '已停止，已完成结果已保留。'
              : (e as Error).message === 'page-range'
                ? '页码范围无效。'
                : localToolErrors[(e as Error).message] || '处理失败，请查看诊断信息。',
          ),
        );
        const d = await window.surfaceDesktop?.documentTools?.run({ action: 'diagnostics' });
        if (alive.current) setLogs(d?.logs || '');
      }
    } finally {
      controller.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const applyPreview = async () => {
    if (!preview || busy) return;
    const page = current.current.pages.find((p) => p.id === preview.page.id);
    if (page !== preview.page) {
      setStatus(t('页面已改变，请重新预览。'));
      return;
    }
    const a = new AbortController();
    controller.current = a;
    setBusy(true);
    try {
      await onApply(
        [await applyCorrection(page, preview.target, preview.image, preview.model, a.signal)],
        [page],
        current.current,
      );
      setPreview(null);
      setStatus(t('已应用矫正，可撤销。'));
    } catch {
      if (alive.current && !a.signal.aborted) setStatus(t('无法应用矫正，请重新预览。'));
    } finally {
      controller.current = null;
      if (alive.current) setBusy(false);
    }
  };
  if (picking)
    return createPortal(
      <div className="local-pick-banner">
        {t('点击需要矫正的图片')}
        <button onClick={() => pickLocalImage(null)}>{t('取消')}</button>
      </div>,
      document.body,
    );
  return (
    <>
      {confirmation}
      <div className={`modal-scrim${panel.hidden ? ' background-hidden' : ''}`}>
        <section
          className="modal local-document-dialog"
          role="dialog"
          aria-modal={panel.hidden ? undefined : true}
          aria-label={t(kind === 'correct' ? '文档矫正' : '五线谱识别')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <header>
            <h2>{t(kind === 'correct' ? '文档矫正' : '五线谱识别')}</h2>
            <button className="icon-button" aria-label={t('关闭文档工具')} onClick={close}>
              <X size={18} />
            </button>
          </header>
          <div className="local-document-body">
            <div className="local-document-options">
              {kind === 'music' && (
                <label>
                  {t('识别后端')}
                  <select
                    aria-label={t('五线谱后端')}
                    disabled={busy || settingUp}
                    value={engine}
                    onChange={(e) => setEngine(e.target.value as LocalToolEngine)}
                  >
                    <option value="audiveris">Audiveris</option>
                    <option value="homr">homr</option>
                  </select>
                </label>
              )}
              <label>
                {t('范围')}
                <select
                  aria-label={t('文档工具范围')}
                  disabled={busy}
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="current">{t('当前页')}</option>
                  <option value="all">{t('全文')}</option>
                  <option value="range">{t('指定页')}</option>
                  {picked && <option value="picked">{t('指定图片')}</option>}
                </select>
              </label>
              {scope === 'range' && (
                <input
                  aria-label={t('文档工具页码范围')}
                  placeholder="1-3, 5"
                  value={range}
                  disabled={busy}
                  onChange={(e) => setRange(e.target.value)}
                />
              )}
              {kind === 'correct' && (
                <>
                  <label>
                    {t('矫正方式')}
                    <select
                      aria-label={t('矫正方式')}
                      value={mode}
                      disabled={busy}
                      onChange={(e) => {
                        setMode(e.target.value as typeof mode);
                        setPreview(null);
                      }}
                    >
                      <option value="auto">{t('自动')}</option>
                      <option value="scan">{t('扫描倾斜')}</option>
                      <option value="photo">{t('透视与曲面')}</option>
                    </select>
                  </label>
                  <label>
                    {t('设备')}
                    <select
                      aria-label={t('矫正设备')}
                      disabled={busy}
                      value={device}
                      onChange={(e) => setDevice(e.target.value as typeof device)}
                    >
                      {['AUTO', 'NPU', 'GPU', 'CPU'].map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={scanOnly}
                      disabled={busy}
                      onChange={(e) => setScanOnly(e.target.checked)}
                    />
                    {t('仅扫描大图')}
                  </label>
                  <button
                    disabled={busy || settingUp}
                    onClick={() => {
                      setPicking(true);
                      setLocalImagePicker((target) => {
                        if (!alive.current) return;
                        setPicking(false);
                        if (target) {
                          setPicked(target);
                          setScope('picked');
                          setPreview(null);
                        }
                      });
                    }}
                  >
                    {t('点击指定图片')}
                  </button>
                </>
              )}
            </div>
            <LocalToolSetup
              key={engine}
              engine={engine}
              onBusy={setSettingUp}
              onCancel={(cancel) => {
                setupCancel.current = cancel;
              }}
            />
            {preview && (
              <div className="correction-comparison">
                <figure>
                  <figcaption>{t('原图')}</figcaption>
                  <img src={preview.original} alt={t('矫正前')} />
                </figure>
                <figure>
                  <figcaption>
                    {t('预览')} · {preview.device || preview.model}
                  </figcaption>
                  <img src={preview.image} alt={t('矫正后')} />
                </figure>
              </div>
            )}
            {status && <p role="status">{status}</p>}
            {progress.total > 0 && (
              <div>
                <progress max={progress.total} value={progress.done} />
                <small>
                  {progress.done} / {progress.total}
                </small>
              </div>
            )}
            {logs && (
              <details>
                <summary>{t('诊断信息')}</summary>
                <pre>{logs}</pre>
              </details>
            )}
            {kind === 'music' && (
              <p className="model-note">
                {t(
                  '识别结果保存到对应页面，可播放、定位和修正音符。位置为估计值时，谱面定位可能存在误差。',
                )}
              </p>
            )}
          </div>
          <footer>
            {busy ? (
              <button onClick={() => controller.current?.abort()}>{t('停止')}</button>
            ) : (
              <>
                {kind === 'correct' && (
                  <button
                    disabled={settingUp || !window.surfaceDesktop?.documentTools}
                    onClick={() => void start(true)}
                  >
                    {t('预览第一张')}
                  </button>
                )}
                {preview && <button onClick={() => void applyPreview()}>{t('应用预览')}</button>}
                <button
                  className="primary"
                  disabled={settingUp || !window.surfaceDesktop?.documentTools}
                  onClick={() => void start()}
                >
                  {t(kind === 'correct' ? '开始矫正' : '开始识别')}
                </button>
              </>
            )}
          </footer>
        </section>
      </div>
    </>
  );
}
