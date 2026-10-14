import { formulaRows, strokeBounds, formulaCrop, mergeFormulaRows } from './formulaLines';
import TaskCenterButton from './TaskCenterButton';
import { t as tr, useLocale } from './i18n';
import { performanceLedger, performanceOutcome, type PerformanceFinish } from './performanceLedger';
import { useEffect, useId, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import LatexSource from './LatexSource';
import { LatexHistory } from './latexHistory';
import { loadFormulaDraft, saveFormulaDraft, type FormulaDraft } from './formulaDraft';
import { deferredFormulaSave } from './deferredSave';
import { FormulaInk } from './formulaInk';
import katex from 'katex';
import { canvasPngDataUrl } from './canvasPng';
import 'katex/dist/katex.min.css';
import { drawStroke } from './ink';
import { uid, isEraser, hitStroke, type Point, type Stroke } from './model';
import { copyText } from './clipboard';
import {
  loadNativeDevice,
  saveNativeDevice,
  connectNativeTexo,
  type NativeDevice,
} from './nativeTexo';
import { useProviderConfig } from './providerSettings';
import { ProviderAdvanced } from './ProviderAdvanced';
import { executeProvider, providerResultStatus, providerFailureStatus } from './providers';
import { loadMacros, parseMacros, saveMacros, formatMacros, type LatexMacros } from './latexMacros';
export default function FormulaDialog({
  onClose,
  onInsert,
  initialLatex = '',
  initialMacros,
  editing = false,
  draftKey,
}: {
  onClose: () => void;
  onInsert: (data: string, w: number, h: number, latex: string, macros: LatexMacros) => void;
  initialLatex?: string;
  initialMacros?: LatexMacros;
  editing?: boolean;
  draftKey: string;
}) {
  useLocale();
  const settingsId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState('');
  const draftWritable = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    result = useRef<HTMLDivElement>(null),
    active = useRef<Stroke | null>(null),
    owner = useRef<number | null>(null),
    strokes = useRef<Stroke[]>([]);
  const [latex, setLatexState] = useState(initialLatex),
    [status, setStatus] = useState(
      tr(
        '\u5728\u4E0B\u65B9\u5199\u4E00\u4E2A\u516C\u5F0F\uFF0C\u7136\u540E\u70B9\u51FB\u8BC6\u522B\u3002',
      ),
    ),
    [busy, setBusy] = useState(false),
    [reachable, setReachable] = useState(false);
  const [insertionPosition, setInsertionPositionState] = useState(initialLatex.length);
  const textHistory = useRef(new LatexHistory(initialLatex));
  const setLatex = (value: string, position = textHistory.current.current.position, kind = '') => {
    textHistory.current.commit(value, position, kind);
    setLatexState(value);
    setInsertionPositionState(position);
  };
  const setInsertionPosition = (position: number) => {
    textHistory.current.move(position);
    setInsertionPositionState(position);
  };
  const travelText = (redo = false) => {
    const entry = redo ? textHistory.current.redo() : textHistory.current.undo();
    if (entry) {
      setLatexState(entry.value);
      setInsertionPositionState(entry.position);
    }
  };
  const api = useProviderConfig('formula', 'texo-native');
  const { provider: config, patch, selectProvider } = api,
    provider = config.type;
  const [nativeDevice, setNativeDevice] = useState(loadNativeDevice),
    [nativeStatus, setNativeStatus] = useState(''),
    [checkingNative, setCheckingNative] = useState(false);
  const [multiline, setMultiline] = useState(false),
    [byRow, setByRow] = useState(true);
  const [unimumerDevice, setUnimumerDevice] = useState<NativeDevice>(() => {
    try {
      const v = localStorage.getItem('surfacetab.unimumerDevice');
      return v === 'CPU' || v === 'GPU' ? v : 'AUTO';
    } catch {
      return 'AUTO';
    }
  });
  const drawingHeight = multiline ? 640 : 320;
  const abort = useRef<AbortController | null>(null);
  const [macros, setMacros] = useState<LatexMacros>(() => ({ ...loadMacros(), ...initialMacros }));
  const [macroDraft, setMacroDraft] = useState(() =>
      formatMacros({ ...loadMacros(), ...initialMacros }),
    ),
    [macroError, setMacroError] = useState('');
  const mounted = useRef(true);
  const committed = useRef<HTMLCanvasElement | null>(null),
    frame = useRef(0),
    dirty = useRef(true);
  const ink = useRef<FormulaInk | null>(null);
  ink.current ??= new FormulaInk();
  const draft = useRef<{ ready: boolean; value: FormulaDraft }>(null!);
  draft.current = {
    ready: draftReady,
    value: {
      version: 1,
      latex,
      position: insertionPosition,
      strokes: strokes.current,
      multiline,
      byRow,
      macros,
      macroDraft,
    },
  };
  const saveDraft = () => {
    if (!draft.current.ready || !draftWritable.current) return;
    const value = {
      ...draft.current.value,
      strokes: active.current ? [...strokes.current, active.current] : strokes.current,
    };
    void saveFormulaDraft(draftKey, value)
      .then(() => {
        if (mounted.current) setDraftError('');
      })
      .catch(() => {
        if (mounted.current) setDraftError(tr('公式草稿保存失败，请复制 LaTeX 并保留画板截图。'));
      });
  };
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  const saver = useRef<ReturnType<typeof deferredFormulaSave> | null>(null);
  saver.current ??= deferredFormulaSave(() => saveRef.current());
  const persistRef = useRef(() => saver.current!.schedule());
  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    void loadFormulaDraft(draftKey)
      .then((saved) => {
        if (cancelled) return;
        draftWritable.current = true;
        if (saved) {
          strokes.current = saved.strokes;
          textHistory.current.reset(saved.latex, saved.position);
          setLatexState(saved.latex);
          setInsertionPosition(saved.position);
          setMultiline(saved.multiline);
          setByRow(saved.byRow);
          setMacros(saved.macros);
          setMacroDraft(saved.macroDraft);
        }
        setDraftReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setDraftError(tr('无法读取公式草稿，请检查本机存储空间。'));
          // Keep storage untouched if reading failed; edits can still be copied or inserted.
          setDraftReady(true);
        }
      });
    const flush = () => {
      // Include a still-active pen stroke on pagehide; a normal close only flushes changes.
      if (active.current) persistRef.current();
      saver.current!.flush();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      cancelled = true;
      mounted.current = false;
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [draftKey]);
  useEffect(() => {
    if (draftReady) persistRef.current();
  }, [draftReady, latex, insertionPosition, multiline, byRow, macros, macroDraft]);
  const redraw = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const finish = paintFinish.current ?? performanceLedger?.begin('formula-paint');
    paintFinish.current = undefined;
    try {
      committed.current ??= document.createElement('canvas');
      const base = committed.current;
      if (dirty.current) {
        if (!ink.current!.paint(base, strokes.current, drawingHeight)) {
          finish?.('cancelled');
          return;
        }
        dirty.current = false;
      }
      const ctx = canvas.current!.getContext('2d', { desynchronized: true })!;
      ctx.drawImage(base, 0, 0);
      if (active.current) drawStroke(ctx, active.current);
      finish?.();
    } catch (error) {
      finish?.(performanceOutcome(error));
      throw error;
    }
  };
  const paintFinish = useRef<PerformanceFinish | undefined>(undefined);
  const recoveryDraw = useRef(() => {});
  const queueDraw = () => {
    if (!frame.current) {
      paintFinish.current = performanceLedger?.begin('formula-paint');
      frame.current = requestAnimationFrame(redraw);
    }
  };
  recoveryDraw.current = queueDraw;
  useEffect(() => {
    redraw();
    const base = committed.current!,
      visible = canvas.current!;
    const invalidate = () => {
      ink.current!.reset();
      dirty.current = true;
    };
    const restore = () => {
      invalidate();
      recoveryDraw.current();
    };
    for (const target of [base, visible]) {
      target.addEventListener('contextlost', invalidate);
      target.addEventListener('contextrestored', restore);
    }
    return () => {
      for (const target of [base, visible]) {
        target.removeEventListener('contextlost', invalidate);
        target.removeEventListener('contextrestored', restore);
      }
      mounted.current = false;
      abort.current?.abort();
      cancelAnimationFrame(frame.current);
      paintFinish.current?.('cancelled');
      paintFinish.current = undefined;
    };
  }, []);
  useEffect(() => {
    dirty.current = true;
    redraw();
  }, [drawingHeight, draftReady]);
  useEffect(() => {
    if (result.current)
      katex.render(latex || tr('\\text{\u516C\u5F0F\u9884\u89C8}'), result.current, {
        macros: { ...macros },
        throwOnError: false,
        displayMode: true,
        trust: false,
        maxExpand: 1000,
      });
  }, [latex, macros]);
  const point = (e: {
    clientX: number;
    clientY: number;
    pointerType: string;
    pressure: number;
  }): Point => {
    const r = canvas.current!.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / r.width) * 960,
      ((e.clientY - r.top) / r.height) * drawingHeight,
      e.pointerType === 'pen' ? Math.max(0.01, e.pressure) : 0.5,
    ];
  };
  const recognize = async (mode: 'replace' | 'insert') => {
    if (owner.current !== null || busy || !draftReady) return;
    if (!strokes.current.length) {
      setStatus(tr('\u8BF7\u5148\u624B\u5199\u4E00\u4E2A\u516C\u5F0F'));
      return;
    }
    setBusy(true);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setStatus(
      tr(
        '\u672C\u5730\u8BC6\u522B\u4E2D\uFF0C\u9996\u6B21\u52A0\u8F7D\u6A21\u578B\u53EF\u80FD\u9700\u8981\u8F83\u957F\u65F6\u95F4\u2026',
      ),
    );
    try {
      redraw();
      const rows =
        multiline && byRow ? formulaRows(strokes.current) : [strokeBounds(strokes.current)!];
      if (rows.length > 12) throw new Error(tr('公式行数过多，请分批识别（最多 12 行）'));
      const valid = () =>
        mounted.current && abort.current === controller && !controller.signal.aborted;
      const values: string[] = [];
      let elapsed = 0,
        fallback = false;
      let last: Awaited<ReturnType<typeof executeProvider>> | undefined;
      // One row at a time reuses the resident model and bounds peak memory.
      for (const [i, bounds] of rows.entries()) {
        controller.signal.throwIfAborted();
        const { x, y, w, h } = formulaCrop(bounds, 960, drawingHeight);
        const crop = document.createElement('canvas');
        crop.width = w;
        crop.height = h;
        crop.getContext('2d')!.drawImage(committed.current!, x, y, w, h, 0, 0, w, h);
        const progress = (value: string) => {
          if (valid())
            setStatus(
              rows.length > 1 ? tr('第 {0} / {1} 行 · {2}', i + 1, rows.length, value) : value,
            );
        };
        last = await executeProvider(
          {
            feature: 'formula',
            config,
            input: crop.toDataURL('image/png'),
            device: provider === 'unimumer' ? unimumerDevice : nativeDevice,
          },
          {
            signal: controller.signal,
            onProgress: progress,
          },
        );
        if (!last.text?.trim()) throw new Error(tr('识别失败'));
        values.push(last.text);
        elapsed += last.elapsed;
        fallback ||= last.fallback;
        crop.width = crop.height = 1;
      }
      if (valid() && last) {
        const recognized = mergeFormulaRows(values);
        const at = Math.max(0, Math.min(latex.length, insertionPosition));
        setLatex(
          mode === 'insert' ? latex.slice(0, at) + recognized + latex.slice(at) : recognized,
        );
        setInsertionPosition((mode === 'insert' ? at : 0) + recognized.length);
        setReachable(!fallback);
        setStatus(
          (rows.length > 1 ? tr('识别行数：{0}', rows.length) + ' · ' : '') +
            providerResultStatus({ ...last, elapsed, fallback }),
        );
      }
    } catch (error) {
      if (mounted.current && abort.current === controller && !controller.signal.aborted)
        setStatus(providerFailureStatus(error, ['web', 'llm', 'pix2text'].includes(provider)));
    } finally {
      if (mounted.current && abort.current === controller) setBusy(false);
    }
  };
  return (
    <div className="modal-scrim">
      <section
        className="modal formula-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tr('手写公式')}
      >
        <header>
          <div>
            <h2>{tr('手写公式')}</h2>
          </div>
          <div className="row formula-header-actions">
            <button
              aria-label={tr('公式设置')}
              aria-expanded={settingsOpen}
              aria-controls={settingsId}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 size={18} aria-hidden="true" />
              {tr('设置')}
            </button>
            <button className="icon-button" aria-label={tr('关闭')} onClick={onClose}>
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="formula-body">
          {draftError && (
            <p role="alert" className="error">
              {draftError}
            </p>
          )}
          <section
            id={settingsId}
            className="formula-settings-panel"
            aria-label={tr('公式设置')}
            hidden={!settingsOpen}
          >
            <div className="row spread">
              <label className="row">
                <span className="field-label">{tr('识别后端')}</span>
                <select
                  aria-label={tr('公式识别后端')}
                  value={provider}
                  disabled={busy || !api.ready}
                  onChange={(e) => selectProvider(e.target.value)}
                >
                  <option value="texo-native">{tr('Texo · 本地低功耗优先')}</option>
                  <option value="unimumer">{tr('Uni-MuMER Qwen3-VL-2B · 本地实验')}</option>
                  <option value="texo-cpu">{tr('Texo · 本地 CPU')}</option>
                  <option value="texo-gpu">{tr('Texo · Intel GPU（实验）')}</option>
                  <option value="pix2text">
                    {tr('Pix2Text · 本地服务')}
                    {reachable ? tr('（已连接）') : tr('（未连接）')}
                  </option>
                  <option value="web">HTTP Formula API</option>
                  <option value="llm">{tr('图像 LLM API')}</option>
                </select>
              </label>
            </div>
            {provider === 'texo-native' && (
              <details className="native-texo-settings">
                <summary>{tr('本地加速设置')}</summary>
                <label>
                  {tr('推理设备')}
                  <select
                    aria-label={tr('推理设备')}
                    disabled={busy}
                    value={nativeDevice}
                    onChange={(e) => {
                      const device = e.target.value as NativeDevice;
                      setNativeDevice(device);
                      saveNativeDevice(device);
                    }}
                  >
                    <option value="AUTO">{tr('自动 · NPU → GPU → CPU')}</option>
                    <option value="NPU">NPU</option>
                    <option value="GPU">GPU</option>
                    <option value="CPU">CPU</option>
                  </select>
                </label>
                <p>{tr('编码器优先使用 NPU，解码器使用 2 线程 CPU；不可用时自动回退。')}</p>
                <button
                  disabled={busy || checkingNative}
                  onClick={async () => {
                    setCheckingNative(true);
                    try {
                      const health = await connectNativeTexo();
                      if (mounted.current)
                        setNativeStatus(health.devices.map((d) => d.id).join(' · '));
                    } catch {
                      if (mounted.current) setNativeStatus(tr('尚未安装本地加速运行时'));
                    } finally {
                      if (mounted.current) setCheckingNative(false);
                    }
                  }}
                >
                  {tr('连接本地加速')}
                </button>
                <p role="status">{nativeStatus}</p>
                <p className="muted">
                  {tr(
                    '首次安装：运行应用目录中的 backend/start-openvino.ps1 -Install。安装后按需自动启动；未安装时使用内置 CPU。',
                  )}
                </p>
              </details>
            )}
            {provider === 'unimumer' && (
              <div className="native-texo-settings">
                <p>
                  {tr(
                    'Uni-MuMER 使用 GPU 或 CPU；不支持 NPU。请先在本地模型管理中下载模型及运行时。',
                  )}
                </p>
                <label>
                  {tr('推理设备')}
                  <select
                    aria-label={tr('推理设备')}
                    disabled={busy}
                    value={unimumerDevice}
                    onChange={(e) => {
                      const d = e.target.value as NativeDevice;
                      setUnimumerDevice(d);
                      try {
                        localStorage.setItem('surfacetab.unimumerDevice', d);
                      } catch {
                        /* Session selection remains usable. */
                      }
                    }}
                  >
                    <option value="AUTO">{tr('自动 · GPU → CPU')}</option>
                    <option value="GPU">{tr('Intel GPU（Vulkan）')}</option>
                    <option value="CPU">CPU</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={config.fallback}
                    onChange={(e) => patch({ fallback: e.target.checked })}
                  />
                  {tr('失败时使用 Texo')}
                </label>
              </div>
            )}
            {['pix2text', 'web', 'llm'].includes(provider) && (
              <fieldset className="provider-config" disabled={busy || !api.ready}>
                <label>
                  {tr('接口地址')}
                  <input
                    maxLength={2048}
                    aria-label={tr('公式接口地址')}
                    value={config.url}
                    onChange={(e) => patch({ url: e.target.value })}
                  />
                </label>
                {provider === 'llm' && (
                  <label>
                    {tr('模型')}
                    <input
                      maxLength={256}
                      aria-label={tr('公式模型')}
                      value={config.model}
                      onChange={(e) => patch({ model: e.target.value })}
                    />
                  </label>
                )}
                <label>
                  API Key
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={8192}
                    aria-label={tr('公式 API Key')}
                    value={config.key}
                    onChange={(e) => patch({ key: e.target.value })}
                  />
                </label>
                <label className="provider-checkbox">
                  <input
                    type="checkbox"
                    checked={config.fallback}
                    onChange={(e) => patch({ fallback: e.target.checked })}
                  />
                  {tr('远程失败时使用本地后端')}
                </label>
                <ProviderAdvanced feature="formula" {...api} disabled={busy} />
              </fieldset>
            )}
            <div className="row formula-row-options">
              <label className="row">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={multiline}
                  onChange={(e) => {
                    if (owner.current !== null) return;
                    if (!e.target.checked && (strokeBounds(strokes.current)?.bottom ?? 0) > 320) {
                      setStatus(tr('请先清空多行画板再切换为单行'));
                      return;
                    }
                    setMultiline(e.target.checked);
                  }}
                />
                {tr('多行手写公式')}
              </label>
              {multiline && (
                <select
                  aria-label={tr('多行识别方式')}
                  disabled={busy}
                  value={byRow ? 'rows' : 'whole'}
                  onChange={(e) => {
                    if (owner.current === null) setByRow(e.target.value === 'rows');
                  }}
                >
                  <option value="rows">{tr('按行识别')}</option>
                  <option value="whole">{tr('整体识别')}</option>
                </select>
              )}
            </div>
            {multiline && (
              <p className="muted formula-row-help">
                {tr('多行模式下请在各行之间留出空白；分数和上下标应保持在同一行内。')}
              </p>
            )}
            <details className="macro-library">
              <summary>{tr('Predefine · 常用命令（{0}）', Object.keys(macros).length)}</summary>
              <p>{tr('支持 LaTeX 命令定义（也兼容 JSON）；支持 #1、#2 参数。例如：')}</p>
              <code>{'{"\\\\RR":"\\\\mathbb{R}","\\\\vect":"\\\\mathbf{#1}"}'}</code>
              <label className="field-label" htmlFor="latex-macros">
                {tr('预定义命令')}
              </label>
              <textarea
                id="latex-macros"
                spellCheck={false}
                value={macroDraft}
                onChange={(e) => setMacroDraft(e.target.value)}
              />
              <div className="row">
                <button
                  onClick={() => {
                    try {
                      const next = parseMacros(macroDraft);
                      saveMacros(next);
                      setMacros(next);
                      setMacroError('');
                      setStatus(tr('预定义命令已保存到本机'));
                    } catch (e) {
                      setMacroError(e instanceof Error ? e.message : tr('保存失败'));
                    }
                  }}
                >
                  {tr('保存预定义命令')}
                </button>
                <span role="status" className="error">
                  {tr(macroError)}
                </span>
              </div>
            </details>
          </section>
          <div className="row formula-drawing-actions">
            <button
              disabled={busy || !draftReady}
              onClick={() => {
                strokes.current = [];
                active.current = null;
                dirty.current = true;
                redraw();
                persistRef.current();
              }}
            >
              {tr('清空画板')}
            </button>
          </div>
          <div
            className="formula-drawing"
            style={{
              maxHeight: multiline ? '400px' : undefined,
              overflow: multiline ? 'auto' : undefined,
            }}
          >
            <canvas
              className="formula-canvas"
              ref={canvas}
              width={960}
              height={drawingHeight}
              style={{ height: multiline ? 440 : 220 }}
              onPointerDown={(e) => {
                if (
                  busy ||
                  !draftReady ||
                  e.pointerType === 'touch' ||
                  owner.current !== null ||
                  (e.button !== 0 && !isEraser(e))
                )
                  return;
                e.currentTarget.setPointerCapture(e.pointerId);
                owner.current = e.pointerId;
                if (isEraser(e)) {
                  strokes.current = strokes.current.filter(
                    (s) => !hitStroke(s, point(e), point(e), 16),
                  );
                  dirty.current = true;
                } else
                  active.current = {
                    id: uid(),
                    tool: 'pen',
                    color: '#202a40',
                    size: 5,
                    points: [point(e)],
                  };
                queueDraw();
              }}
              onPointerMove={(e) => {
                if (e.pointerId !== owner.current) return;
                if (active.current) {
                  const events = e.nativeEvent.getCoalescedEvents?.();
                  for (const sample of events?.length ? events : [e.nativeEvent])
                    active.current.points.push(point(sample));
                } else {
                  strokes.current = strokes.current.filter(
                    (s) => !hitStroke(s, point(e), point(e), 16),
                  );
                  dirty.current = true;
                }
                queueDraw();
              }}
              onPointerUp={(e) => {
                if (e.pointerId !== owner.current) return;
                if (active.current) {
                  strokes.current = [...strokes.current, active.current];
                  dirty.current = true;
                }
                active.current = null;
                owner.current = null;
                redraw();
                persistRef.current();
              }}
              onPointerCancel={(e) => {
                if (e.pointerId === owner.current) {
                  active.current = null;
                  owner.current = null;
                  redraw();
                  persistRef.current();
                }
              }}
              onLostPointerCapture={(e) => {
                if (e.pointerId === owner.current) {
                  active.current = null;
                  owner.current = null;
                  redraw();
                  persistRef.current();
                }
              }}
            />
          </div>

          <div className="row spread">
            <p className="formula-status" role="status">
              {tr(status)}
            </p>
            <div className="row formula-recognize-actions">
              <button
                disabled={busy || !api.ready || !draftReady}
                onClick={() => void recognize('replace')}
              >
                {tr('识别并覆盖')}
              </button>
              <button
                className="primary"
                disabled={busy || !api.ready || !draftReady}
                onClick={() => void recognize('insert')}
              >
                {tr('识别并插入')}
              </button>
            </div>
            {busy && (
              <button
                onClick={() => {
                  abort.current?.abort();
                  setBusy(false);
                  setStatus(tr('已取消'));
                }}
              >
                {tr('取消识别')}
              </button>
            )}
          </div>
          <LatexSource
            value={latex}
            position={insertionPosition}
            disabled={busy || !draftReady}
            onChange={setLatex}
            onPosition={setInsertionPosition}
            onUndo={() => travelText()}
            onRedo={() => travelText(true)}
            canUndo={textHistory.current.canUndo}
            canRedo={textHistory.current.canRedo}
          />
          <div className="formula-preview" ref={result} />

          <footer>
            <TaskCenterButton />
            <span>{tr('Texo 按需加载；闲置卸载时间可在任务与后端中设置。')}</span>
            <button
              disabled={!latex.trim()}
              onClick={() =>
                void copyText(latex)
                  .then(() => setStatus(tr('LaTeX 已复制')))
                  .catch(() => setStatus(tr('复制不可用，请手动复制上方文本')))
              }
            >
              {tr('复制 LaTeX')}
            </button>
            <button
              className="primary"
              disabled={busy || !latex.trim()}
              onClick={async () => {
                try {
                  // KaTeX HTML stays editable in the dialog; the paper receives its transparent PNG snapshot.
                  const { default: html2canvas } = await import('html2canvas');
                  const element = result.current!.querySelector<HTMLElement>('.katex')!,
                    bounds = element.getBoundingClientRect();
                  const scale = Math.min(
                    8,
                    Math.sqrt(8_000_000 / Math.max(1, bounds.width * bounds.height)),
                  );
                  const c = await html2canvas(element, {
                    backgroundColor: null,
                    scale,
                    onclone: (doc) => {
                      const preview = doc.querySelector<HTMLElement>('.formula-preview');
                      if (preview) preview.style.color = '#23324d';
                    },
                  });
                  onInsert(
                    await canvasPngDataUrl(c),
                    (c.width / scale) * 2,
                    (c.height / scale) * 2,
                    latex,
                    macros,
                  );
                } catch {
                  setStatus(tr('公式插入失败，请复制 LaTeX 保存'));
                }
              }}
            >
              {editing ? tr('更新公式') : tr('插入当前页')}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
