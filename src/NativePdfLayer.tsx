import { useContext, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, FilePenLine, Download } from 'lucide-react';
import { DocumentEditContext } from './DocumentEditContext';
import { uid, type Page } from './model';
import { t, useLocale } from './i18n';
import { pdfEditErrors, type NativePdfElement, type NativePdfEdit } from './pdfNativeTypes';
import { runPdfEditor, setLiveNativeEdit } from './nativePdfDrafts';
import { NativePreviewMirror } from './NativePdfPreview';
import { imageFile } from './svgImport';
import RuntimeInstallProgress, { runtimeErrors } from './RuntimeInstallProgress';
import { useRuntimeInstall, installRuntime } from './runtimeInstall';
import { useRuntimeClose } from './useRuntimeClose';
import RuntimeDownloadSettings from './RuntimeDownloadSettings';
import './pageEditing.css';

export default function NativePdfLayer({
  page,
  zoom,
  active,
}: {
  page: Page;
  zoom: number;
  active: boolean;
}) {
  useLocale();
  const context = useContext(DocumentEditContext),
    bridge = window.surfaceDesktop?.pdfEditor;
  const source = context?.notebook.source;
  const [elements, setElements] = useState<NativePdfElement[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<NativePdfElement | null>(null),
    [dialogOpen, setDialogOpen] = useState(false),
    [retry, setRetry] = useState(0),
    [setup, setSetup] = useState(false);
  const runtime = useRuntimeInstall(),
    installing = runtime.active === 'pdf';
  const { close: closeSetup, confirmation } = useRuntimeClose(() => setSetup(false), 'pdf');
  const request = useRef<string | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setLiveNativeEdit(page.id, null);
      if (request.current) void bridge?.run({ action: 'cancel', id: request.current });
    };
  }, [bridge]);
  useEffect(() => {
    setElements([]);
    setSelected(null);
    setError('');
    if (!active || !source || page.sourceIndex === null || !bridge) return;
    const id = uid();
    request.current = id;
    let dead = false;
    setLoading(true);
    void runPdfEditor({ action: 'inspect', id, source, page: page.sourceIndex })
      .then((result) => {
        if (dead) return;
        if (result.ok && result.data?.elements) {
          if (
            Math.abs((result.data.width ?? page.width) - page.width) > 0.1 ||
            Math.abs((result.data.height ?? page.height) - page.height) > 0.1
          )
            setError('invalid-rect');
          else setElements(result.data.elements);
        } else setError(result.error || 'pdf-edit');
      })
      .catch(() => {
        if (!dead) setError('pdf-edit');
      })
      .finally(() => {
        if (!dead) setLoading(false);
        if (request.current === id) request.current = null;
      });
    return () => {
      dead = true;
      void bridge.run({ action: 'cancel', id });
    };
  }, [source, page.id, page.sourceIndex, active, bridge, retry]);
  async function install() {
    setError('');
    try {
      const result = await installRuntime('pdf');
      if (alive.current) {
        if (result.ok) {
          setSetup(false);
          setRetry((n) => n + 1);
        } else setError(runtimeErrors[result.error || 'setup'] || 'pdf-edit');
      }
    } catch {
      if (alive.current) setError('pdf-edit');
    }
  }
  const status =
    !source || page.sourceIndex === null
      ? t('此页没有可编辑的原生 PDF 元素。')
      : !bridge
        ? t('PDF 原生元素编辑需要桌面应用。')
        : !active
          ? t('点击此页加载原生元素')
          : loading
            ? t('读取 PDF 元素…')
            : error
              ? t(pdfEditErrors[error] || error)
              : !elements.length
                ? t('此页未找到文本或图片元素。')
                : '';
  return (
    <div className="native-pdf-layer">
      {status && (
        <div className="native-pdf-status" onPointerDown={(e) => e.stopPropagation()}>
          {status}
          {error && (
            <button
              onClick={() =>
                error === 'runtime-missing' ? setSetup(true) : setRetry((n) => n + 1)
              }
            >
              {t(error === 'runtime-missing' ? '安装运行时' : '重试')}
            </button>
          )}
        </div>
      )}
      {elements.map((e) => {
        const draft = page.pdfEdits?.find((d) => d.element.id === e.id);
        if (draft?.delete) return null;
        const edit: NativePdfEdit = draft ?? {
          element: e,
          rect: e.rect,
          text: e.text,
          fontSize: e.fontSize,
          color: e.color,
        };
        return (
          <NativePdfBox
            key={e.id}
            page={page}
            rect={edit.rect}
            zoom={zoom}
            selected={selected?.id === e.id}
            label={t(e.kind === 'text' ? '编辑原生文本' : '编辑原生图片')}
            title={edit.text?.slice(0, 120) || t('原生图片')}
            blocked={!!e.blocked}
            onSelect={() => {
              setSelected(e);
              setDialogOpen(true);
            }}
            onPreview={(rect) => setLiveNativeEdit(page.id, { ...edit, rect })}
            onCommit={(rect) => {
              context?.stageNative(page.id, { ...edit, rect });
              setLiveNativeEdit(page.id, null);
              setSelected(e);
            }}
            onCancel={() => setLiveNativeEdit(page.id, null)}
          />
        );
      })}
      {setup &&
        createPortal(
          <div className="modal-backdrop" onPointerDown={(e) => e.stopPropagation()}>
            <section
              className="editing-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={t('PDF 编辑运行时')}
            >
              <header>
                <FilePenLine size={18} />
                <h2>{t('PDF 编辑运行时')}</h2>
                <button aria-label={t('关闭')} onClick={closeSetup}>
                  <X size={18} />
                </button>
              </header>
              <div className="editing-fields">
                <p>
                  {t(
                    '首次使用需下载独立 Python 和 PyMuPDF。按需运行，处理结束后释放内存，不加载 AI 模型。',
                  )}
                </p>
                <RuntimeInstallProgress id="pdf" />
                <RuntimeDownloadSettings />
                {error && error !== 'runtime-missing' && (
                  <p role="alert">{t(pdfEditErrors[error] || error)}</p>
                )}
              </div>
              <footer>
                <button disabled={installing} className="primary" onClick={() => void install()}>
                  <Download size={16} />
                  {t('自动安装')}
                </button>
              </footer>
            </section>
          </div>,
          document.body,
        )}
      {selected &&
        dialogOpen &&
        source &&
        createPortal(
          <NativePdfDialog
            key={selected.id}
            element={selected}
            page={page}
            initial={page.pdfEdits?.find((d) => d.element.id === selected.id)}
            onClose={() => setDialogOpen(false)}
            onApply={(next) => {
              context?.stageNative(page.id, next);
              setDialogOpen(false);
            }}
          />,
          document.body,
        )}
      {confirmation}
    </div>
  );
}
function NativePdfDialog({
  element: e,
  page,
  initial,
  onClose,
  onApply,
}: {
  element: NativePdfElement;
  page: Page;
  initial?: NativePdfEdit;
  onClose: () => void;
  onApply: (edit: NativePdfEdit) => void;
}) {
  const [text, setText] = useState(initial?.text ?? e.text ?? ''),
    [fontSize, setFontSize] = useState(initial?.fontSize ?? e.fontSize ?? 12),
    [color, setColor] = useState(initial?.color ?? e.color ?? '#000000');
  const initialRect = initial?.rect ?? e.rect;
  const [box, setBox] = useState({
    x: initialRect[0],
    y: initialRect[1],
    width: initialRect[2] - initialRect[0],
    height: initialRect[3] - initialRect[1],
  });
  const [replacement, setReplacement] = useState<string | undefined>(initial?.replacement),
    [error, setError] = useState('');
  const rect: NativePdfEdit['rect'] = [box.x, box.y, box.x + box.width, box.y + box.height];
  const draft: NativePdfEdit = { element: e, rect, text, fontSize, color, replacement };
  const valid =
    rect.every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width >= 1 &&
    box.height >= 1 &&
    rect[2] <= page.width &&
    rect[3] <= page.height &&
    (e.kind !== 'text' || (!!text.trim() && fontSize >= 1 && fontSize <= 300));
  const changed =
    text !== (initial?.text ?? e.text ?? '') ||
    fontSize !== (initial?.fontSize ?? e.fontSize ?? 12) ||
    color !== (initial?.color ?? e.color ?? '#000000') ||
    replacement !== initial?.replacement ||
    rect.some((value, index) => Math.abs(value - initialRect[index]) > 0.001);
  useEffect(() => {
    if (valid && !e.blocked) setLiveNativeEdit(page.id, draft);
    return () => setLiveNativeEdit(page.id, null);
  }, [text, fontSize, color, replacement, box, valid]);
  function apply(remove = false) {
    if (!remove && !valid) {
      setError('invalid-rect');
      return;
    }
    onApply(remove ? { element: e, rect: e.rect, delete: true } : { ...draft, delete: false });
  }
  const previewScale = Math.min(420 / page.width, 320 / page.height);
  return (
    <div className="modal-backdrop" onPointerDown={(event) => event.stopPropagation()}>
      <section
        className="editing-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('编辑 PDF 原生元素')}
      >
        <header>
          <FilePenLine size={18} />
          <h2>{t(e.kind === 'text' ? '编辑原生文本' : '编辑原生图片')}</h2>
          <button
            aria-label={t('关闭')}
            onClick={() => {
              if (valid && !e.blocked && changed) apply();
              else onClose();
            }}
          >
            <X size={18} />
          </button>
        </header>
        <div className="editing-fields">
          {e.blocked ? (
            <p role="alert">{t(pdfEditErrors[e.blocked])}</p>
          ) : (
            <>
              {e.kind === 'text' ? (
                <>
                  <label>
                    {t('文本内容')}
                    <textarea
                      rows={3}
                      maxLength={10000}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                  </label>
                  <div className="field-row">
                    <label>
                      {t('字号')}
                      <input
                        type="number"
                        min={1}
                        max={300}
                        value={fontSize}
                        onChange={(event) => setFontSize(event.target.valueAsNumber)}
                      />
                    </label>
                    <label>
                      {t('文字颜色')}
                      <input
                        type="color"
                        value={color}
                        onChange={(event) => setColor(event.target.value)}
                      />
                    </label>
                  </div>
                  <p>
                    {t(
                      '优先保留可用原字体和基线；新增字符缺字时使用后备字体。不会自动重排其它元素。',
                    )}
                  </p>
                </>
              ) : (
                <label>
                  {t('替换图片（可选）')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      try {
                        setReplacement((await imageFile(file)).data);
                      } catch {
                        setError('invalid-image');
                      }
                    }}
                  />
                  {replacement && <span>{t('已选择替换图片')}</span>}
                </label>
              )}
              <div className="field-row">
                {(['x', 'y', 'width', 'height'] as const).map((k) => (
                  <label key={k}>
                    {t({ x: '左侧位置', y: '顶部位置', width: '宽度', height: '高度' }[k])}
                    <input
                      type="number"
                      step="0.1"
                      value={Math.round(box[k] * 100) / 100}
                      onChange={(event) => setBox({ ...box, [k]: event.target.valueAsNumber })}
                    />
                  </label>
                ))}
              </div>
              <div
                className="native-dialog-preview"
                aria-label={t('页面编辑预览')}
                style={{ width: page.width * previewScale, height: page.height * previewScale }}
              >
                <NativePreviewMirror page={page} />
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: page.width,
                    height: page.height,
                    transform: `scale(${previewScale})`,
                    transformOrigin: 'top left',
                  }}
                >
                  <NativePdfBox
                    page={page}
                    rect={rect}
                    zoom={previewScale}
                    selected
                    label={t('调整元素边框')}
                    onSelect={() => {}}
                    onPreview={(r) =>
                      setBox({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] })
                    }
                    onCommit={(r) =>
                      setBox({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] })
                    }
                    onCancel={() => {}}
                  />
                </div>
              </div>
              <p>
                {t(
                  '修改暂存到工程。关闭后可在页面上拖动、缩放；点击“应用 PDF 编辑”统一写入，直接导出也会应用。文本不受框大小裁断，其它元素不会自动重排。',
                )}
              </p>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {t(pdfEditErrors[error] || '无法编辑此 PDF，请重试或选择其它元素。')}
            </p>
          )}
        </div>
        <footer>
          <button disabled={!!e.blocked} onClick={() => apply(true)}>
            <Trash2 size={16} />
            {t('删除')}
          </button>
          <button className="primary" disabled={!valid || !!e.blocked} onClick={() => apply()}>
            {t('暂存修改')}
          </button>
        </footer>
      </section>
    </div>
  );
}
function NativePdfBox({
  page,
  rect,
  zoom,
  selected,
  label,
  title,
  blocked,
  onSelect,
  onPreview,
  onCommit,
  onCancel,
}: {
  page: Page;
  rect: NativePdfEdit['rect'];
  zoom: number;
  selected: boolean;
  label: string;
  title?: string;
  blocked?: boolean;
  onSelect: () => void;
  onPreview: (rect: NativePdfEdit['rect']) => void;
  onCommit: (rect: NativePdfEdit['rect']) => void;
  onCancel: () => void;
}) {
  const gesture = useRef<{
      id: number;
      x: number;
      y: number;
      rect: NativePdfEdit['rect'];
      corner?: string;
      moved: boolean;
    } | null>(null),
    suppress = useRef(false);
  const [moving, setMoving] = useState<NativePdfEdit['rect'] | null>(null),
    r = moving ?? rect;
  const adjust = (event: PointerEvent): NativePdfEdit['rect'] => {
    const c = gesture.current!,
      dx = (event.clientX - c.x) / zoom,
      dy = (event.clientY - c.y) / zoom;
    if (Math.hypot(dx, dy) * zoom > 3) c.moved = true;
    let [x, y, right, bottom] = c.rect;
    if (!c.corner) {
      const w = right - x,
        h = bottom - y;
      x = Math.max(0, Math.min(page.width - w, x + dx));
      y = Math.max(0, Math.min(page.height - h, y + dy));
      return [x, y, x + w, y + h];
    }
    if (c.corner.includes('w')) x = Math.max(0, Math.min(right - 1, x + dx));
    if (c.corner.includes('e')) right = Math.min(page.width, Math.max(x + 1, right + dx));
    if (c.corner.includes('n')) y = Math.max(0, Math.min(bottom - 1, y + dy));
    if (c.corner.includes('s')) bottom = Math.min(page.height, Math.max(y + 1, bottom + dy));
    return [x, y, right, bottom];
  };
  return (
    <button
      className={`native-pdf-element ${selected ? 'selected' : ''}`}
      aria-label={label}
      title={title}
      style={{
        left: r[0],
        top: r[1],
        width: r[2] - r[0],
        height: r[3] - r[1],
        borderWidth: 1 / zoom,
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (blocked || event.button !== 0) return;
        suppress.current = false;
        gesture.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          rect,
          corner: (event.target as HTMLElement).closest<HTMLElement>('[data-native-corner]')
            ?.dataset.nativeCorner,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (gesture.current?.id !== event.pointerId) return;
        event.stopPropagation();
        const next = adjust(event);
        setMoving(next);
        onPreview(next);
      }}
      onPointerUp={(event) => {
        if (gesture.current?.id !== event.pointerId) return;
        event.stopPropagation();
        const next = adjust(event),
          moved = gesture.current.moved;
        gesture.current = null;
        setMoving(null);
        suppress.current = moved;
        if (moved) onCommit(next);
        else onCancel();
      }}
      onLostPointerCapture={() => {
        if (gesture.current) {
          gesture.current = null;
          setMoving(null);
          onCancel();
        }
      }}
      onPointerCancel={() => {
        gesture.current = null;
        setMoving(null);
        onCancel();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (suppress.current) {
          suppress.current = false;
          return;
        }
        onSelect();
      }}
    >
      {selected &&
        !blocked &&
        ['nw', 'ne', 'sw', 'se'].map((corner) => (
          <span
            key={corner}
            data-native-corner={corner}
            className={`review-resize-handle ${corner}`}
            style={{ width: 10 / zoom, height: 10 / zoom, borderWidth: 1 / zoom }}
          />
        ))}
    </button>
  );
}
