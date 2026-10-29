import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import CorrectionEditor from './CorrectionEditor';
import { t } from './i18n';
import type { Notebook, Page } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import { scopePages } from './pageOperations';
import { capturePage } from './capturePage';
import LocalToolSetup from './LocalToolSetup';
import { useRuntimeClose } from './useRuntimeClose';
import {
  correctionTargets,
  correctionInput,
  correctTarget,
  applyCorrection,
  type CorrectionTarget,
} from './documentCorrection';
import {
  runLocalDocumentTool,
  localToolErrors,
  correctionEngine,
  defaultCorrection,
  type CorrectionOptions,
  type CorrectionMode,
  type CorrectionPoint,
  type LocalToolEngine,
} from './localDocumentTools';
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
    [mode, setMode] = useState<CorrectionMode>('scan'),
    [options, setOptions] = useState<CorrectionOptions>({ ...defaultCorrection }),
    [previewDirty, setPreviewDirty] = useState(false),
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
    rawOriginal?: string;
    image: string;
    model: string;
    target: CorrectionTarget;
    page: Page;
    device?: string;
    corners?: CorrectionPoint[] | null;
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
  const changeOptions = (next: CorrectionOptions) => {
    setOptions(next);
    setPreviewDirty(true);
  };
  const activeEngine = kind === 'correct' ? correctionEngine(options) : engine;
  const start = async (previewOnly = false, loadOnly = false) => {
    if (controller.current || settingUp) return;
    const origin = current.current;
    const a = new AbortController();
    controller.current = a;
    setBusy(true);
    setLogs('');
    setStatus(t(kind === 'correct' ? '正在统计位图索引…' : '正在识别五线谱…'));
    setProgress({ done: 0, total: 0 });
    if (!previewOnly) setPreview(null);
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
          previewOnly && preview
            ? [preview.target]
            : scope === 'picked' && picked
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
          if (loadOnly) {
            const original = await correctionInput(page, target, pdf, a.signal);
            setPreview({
              original,
              rawOriginal: original,
              image: '',
              model: 'manual',
              target,
              page,
            });
            setPreviewDirty(true);
            setStatus(t('拖动控制点后点击更新预览。'));
            return;
          }
          const result = await correctTarget(
            page,
            target,
            pdf,
            mode,
            device,
            a.signal,
            options,
            previewOnly && preview?.target === target ? preview.original : undefined,
          );
          a.signal.throwIfAborted();
          if (previewOnly) {
            setPreview({
              ...result,
              rawOriginal: preview?.rawOriginal || result.original,
              target,
              page,
            });
            setPreviewDirty(false);
            setStatus(
              t(
                result.warning === 'no-text-curves'
                  ? '未找到可靠的文字曲线，已保留原始几何；可使用曲面网格或 UVDoc。'
                  : '预览已生成，确认后应用。',
              ),
            );
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
              engine === 'homr' || engine === 'copista' ? engine : 'audiveris',
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
    if (!preview?.image || previewDirty || busy) return;
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
      <div
        className={`modal-scrim local-document-scrim${panel.hidden ? ' background-hidden' : ''}`}
      >
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
                    <option value="copista">Copista 28M</option>
                  </select>
                </label>
              )}
              <label>
                {t('范围')}
                <select
                  aria-label={t('文档工具范围')}
                  disabled={busy || settingUp}
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value);
                    setPreview(null);
                    setOptions({ ...options, corners: undefined, mesh: undefined });
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
                  onChange={(e) => {
                    setRange(e.target.value);
                    setPreview(null);
                    setOptions({ ...options, corners: undefined, mesh: undefined });
                  }}
                />
              )}
              {kind === 'correct' && (
                <>
                  <label>
                    {t('矫正方式')}
                    <select
                      aria-label={t('矫正方式')}
                      value={mode}
                      disabled={busy || settingUp}
                      onChange={(e) => {
                        const value = e.target.value as CorrectionMode;
                        setMode(value);
                        changeOptions({
                          ...defaultCorrection,
                          method:
                            value === 'card'
                              ? 'docaligner'
                              : value === 'book' || value === 'wrinkle'
                                ? 'uvdoc'
                                : value === 'photo'
                                  ? 'perspective'
                                  : value === 'manual'
                                    ? 'manual'
                                    : 'projection',
                          aspect: value === 'card' ? 'id-landscape' : 'auto',
                        });
                        setPreview(null);
                      }}
                    >
                      <option value="scan">{t('扫描倾斜')}</option>
                      <option value="card">{t('证件扫描照')}</option>
                      <option value="photo">{t('拍摄透视')}</option>
                      <option value="book">{t('书页弯曲')}</option>
                      <option value="wrinkle">{t('文档褶皱')}</option>
                      <option value="manual">{t('手动校准')}</option>
                    </select>
                  </label>
                  <label>
                    {t('校准算法')}
                    <select
                      aria-label={t('校准算法')}
                      disabled={busy || settingUp}
                      value={options.method}
                      onChange={(e) =>
                        changeOptions({
                          ...options,
                          method: e.target.value as CorrectionOptions['method'],
                          mesh: e.target.value === 'manual' ? options.mesh : undefined,
                        })
                      }
                    >
                      <option value="projection">{t('文字投影纠偏')}</option>
                      <option value="lines">{t('直线角度纠偏')}</option>
                      <option value="perspective">{t('轮廓四角透视')}</option>
                      <option value="docaligner">DocAligner · FastViT T8</option>
                      <option value="book">{t('文字曲线展平')}</option>
                      <option value="uvdoc">UVDoc</option>
                      <option value="manual">{t('手动几何调整')}</option>
                    </select>
                  </label>
                  <label>
                    {t('设备')}
                    <select
                      aria-label={t('矫正设备')}
                      disabled={busy || activeEngine === 'geometry'}
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
                          setOptions({ ...options, corners: undefined, mesh: undefined });
                        }
                      });
                    }}
                  >
                    {t('点击指定图片')}
                  </button>
                </>
              )}
            </div>
            {kind === 'correct' && (
              <div className="correction-adjustments">
                <label>
                  {t('输出比例')}
                  <select
                    aria-label={t('输出比例')}
                    value={options.aspect}
                    disabled={busy}
                    onChange={(e) =>
                      changeOptions({
                        ...options,
                        aspect: e.target.value as CorrectionOptions['aspect'],
                      })
                    }
                  >
                    <option value="auto">{t('保持检测比例')}</option>
                    <option value="id-landscape">{t('证件横向')}</option>
                    <option value="id-portrait">{t('证件纵向')}</option>
                    <option value="a4">A4</option>
                    <option value="letter">Letter</option>
                    <option value="square">1:1</option>
                  </select>
                </label>
                <label>
                  {t('旋转')}
                  <input
                    aria-label={t('校准旋转')}
                    type="range"
                    min={-180}
                    max={180}
                    step={0.1}
                    value={options.rotation}
                    disabled={busy}
                    onChange={(e) =>
                      changeOptions({ ...options, rotation: Number(e.target.value) })
                    }
                  />
                  <input
                    aria-label={t('旋转角度')}
                    type="number"
                    min={-180}
                    max={180}
                    step={0.1}
                    value={options.rotation}
                    disabled={busy}
                    onChange={(e) =>
                      changeOptions({
                        ...options,
                        rotation: Math.max(-180, Math.min(180, Number(e.target.value))),
                      })
                    }
                  />
                </label>
                {['book', 'uvdoc'].includes(options.method) && (
                  <label>
                    {t('展平强度')}
                    <input
                      aria-label={t('展平强度')}
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={options.strength}
                      disabled={busy}
                      onChange={(e) =>
                        changeOptions({ ...options, strength: Number(e.target.value) })
                      }
                    />
                    <output>{Math.round(options.strength * 100)}%</output>
                  </label>
                )}
                <label>
                  {t('阴影均衡')}
                  <input
                    aria-label={t('阴影均衡')}
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={options.lighting}
                    disabled={busy}
                    onChange={(e) =>
                      changeOptions({ ...options, lighting: Number(e.target.value) })
                    }
                  />
                  <output>{Math.round(options.lighting * 100)}%</output>
                </label>
              </div>
            )}
            <LocalToolSetup
              key={activeEngine}
              engine={activeEngine}
              onBusy={setSettingUp}
              onCancel={(cancel) => {
                setupCancel.current = cancel;
              }}
            />
            {preview && (
              <CorrectionEditor
                original={preview.original}
                image={preview.image}
                detected={preview.corners}
                options={options}
                disabled={busy}
                onChange={changeOptions}
                onReset={() => {
                  changeOptions({ ...defaultCorrection, method: 'manual' });
                  setPreview({
                    ...preview,
                    original: preview.rawOriginal || preview.original,
                    image: '',
                    corners: null,
                  });
                }}
                onContinue={() => {
                  changeOptions({ ...defaultCorrection, method: 'manual' });
                  setPreview({ ...preview, original: preview.image, image: '', corners: null });
                }}
              />
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
                  <button disabled={settingUp} onClick={() => void start(true, true)}>
                    {t('选择图片并调整')}
                  </button>
                )}
                {kind === 'correct' && (
                  <button
                    disabled={settingUp || !window.surfaceDesktop?.documentTools}
                    onClick={() => void start(true)}
                  >
                    {t(preview ? '更新预览' : '预览第一张')}
                  </button>
                )}
                {preview && (
                  <button
                    disabled={!preview.image || previewDirty}
                    onClick={() => void applyPreview()}
                  >
                    {t('应用预览')}
                  </button>
                )}
                <button
                  className="primary"
                  disabled={
                    settingUp ||
                    !window.surfaceDesktop?.documentTools ||
                    (kind === 'correct' && !!(options.corners || options.mesh))
                  }
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
