import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentEditContext } from './DocumentEditContext';
import { uid, type Page } from './model';
import {
  nativeRequests,
  pageNativeEdits,
  runPdfEditor,
  useLiveNativeEdit,
} from './nativePdfDrafts';
import { useAppearance, renderPolicy, pageRenderScale } from './appearance';
import { applyNightPolygons } from './pdfNight';
import { t } from './i18n';
import { pdfEditErrors } from './pdfNativeTypes';
import { priorPdfBitmap } from './pdfRenderCache';
const shown = new Map<string, HTMLCanvasElement>();
const statuses = new Map<string, string>();
const announce = () => window.dispatchEvent(new Event('tixtab-native-preview'));
export function NativePreviewMirror({ page }: { page: Page }) {
  const root = useRef<HTMLCanvasElement>(null);
  const context = useContext(DocumentEditContext),
    { pdfNight } = useAppearance();
  const [status, setStatus] = useState(statuses.get(page.id) ?? '');
  useEffect(() => {
    const mounted = root.current;
    const draw = () => {
      const original =
          shown.get(page.id) ??
          (context?.pdf && page.sourceIndex !== null
            ? priorPdfBitmap(context.pdf, page.sourceIndex, pdfNight)
            : undefined),
        target = root.current;
      setStatus(statuses.get(page.id) ?? '');
      if (original && target) {
        const scale = Math.min(
          1,
          ((target.clientWidth || 420) * Math.min(2, window.devicePixelRatio)) / original.width,
        );
        target.width = Math.max(1, Math.ceil(original.width * scale));
        target.height = Math.max(1, Math.ceil(original.height * scale));
        target.getContext('2d')!.drawImage(original, 0, 0, target.width, target.height);
      }
    };
    draw();
    window.addEventListener('tixtab-native-preview', draw);
    return () => {
      window.removeEventListener('tixtab-native-preview', draw);
      if (mounted) mounted.width = mounted.height = 1;
    };
  }, [page.id, page.sourceIndex, context?.pdf, pdfNight]);
  return (
    <>
      <canvas ref={root} width={1} height={1} />
      {status && (
        <span className="native-dialog-preview-status" role="status">
          {status}
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('tixtab-native-preview-retry', { detail: page.id }),
              )
            }
          >
            {t('重试')}
          </button>
        </span>
      )}
    </>
  );
}
export default function NativePdfPreview({ page, zoom }: { page: Page; zoom: number }) {
  const source = useContext(DocumentEditContext)?.notebook.source,
    live = useLiveNativeEdit(page.id);
  const edits = useMemo(() => pageNativeEdits(page, live), [page.pdfEdits, live]);
  const { pdfNight } = useAppearance();
  const policy = renderPolicy(),
    scale = pageRenderScale(zoom, window.devicePixelRatio, page.width, page.height, false, policy);
  const root = useRef<HTMLDivElement>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    [warning, setWarning] = useState(false);
  useEffect(() => {
    const retry = (event: Event) => {
      if ((event as CustomEvent).detail === page.id) setRetry((n) => n + 1);
    };
    window.addEventListener('tixtab-native-preview-retry', retry);
    return () => window.removeEventListener('tixtab-native-preview-retry', retry);
  }, [page.id]);
  useEffect(() => {
    if (!source || page.sourceIndex === null || !edits.length) return;
    const controller = new AbortController();
    let raster: HTMLCanvasElement | undefined;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await runPdfEditor(
          {
            action: 'preview',
            id: uid(),
            source,
            page: page.sourceIndex!,
            edits: nativeRequests(page, edits),
            scale,
            maxPixels: policy.basePixels,
          },
          controller.signal,
        );
        if (!result.ok || !result.data?.preview) throw Error(result.error || 'pdf-edit');
        controller.signal.throwIfAborted();
        const image = new Image();
        image.src = result.data.preview;
        await image.decode();
        controller.signal.throwIfAborted();
        raster = document.createElement('canvas');
        raster.width = image.naturalWidth;
        raster.height = image.naturalHeight;
        raster.getContext('2d')!.drawImage(image, 0, 0);
        if (pdfNight) await applyNightPolygons(raster, result.data.polygons ?? [], true);
        controller.signal.throwIfAborted();
        if (root.current) {
          for (const old of root.current.querySelectorAll('canvas')) old.width = old.height = 1;
          root.current.replaceChildren(raster);
          shown.set(page.id, raster);
          statuses.delete(page.id);
          announce();
          setError('');
          setWarning(result.data.warning === 'font-replaced');
        }
      })()
        .catch((e) => {
          if (!controller.signal.aborted) {
            const message = t(pdfEditErrors[e.message] ?? '暂存预览失败，请重试。');
            setError(message);
            statuses.set(page.id, message);
            announce();
          }
        })
        .finally(() => {
          if (raster && (!root.current || !root.current.contains(raster)))
            raster.width = raster.height = 1;
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, page.id, page.sourceIndex, edits, pdfNight, scale, policy.basePixels, retry]);
  useEffect(() => {
    const host = root.current;
    return () => {
      statuses.delete(page.id);
      for (const canvas of host?.querySelectorAll('canvas') ?? []) {
        if (shown.get(page.id) === canvas) shown.delete(page.id);
        canvas.width = canvas.height = 1;
      }
    };
  }, [page.id]);
  return (
    <>
      {warning && !error && (
        <span className="native-preview-error" role="status">
          {t('原字体缺少部分字符，预览已使用同类后备字体。')}
        </span>
      )}
      <div className="native-pdf-preview" ref={root} aria-label={t('PDF 暂存预览')} />
      {error && (
        <span className="native-preview-error" role="status">
          {error}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            {t('重试')}
          </button>
        </span>
      )}
    </>
  );
}
