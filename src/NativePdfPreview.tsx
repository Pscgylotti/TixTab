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
const shown = new Map<string, HTMLCanvasElement>();
export function NativePreviewMirror({ page }: { page: Page }) {
  const root = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const mounted = root.current;
    const draw = () => {
      const original = shown.get(page.id),
        target = root.current;
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
  }, [page.id]);
  return <canvas ref={root} width={1} height={1} />;
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
    [warning, setWarning] = useState(false);
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
          window.dispatchEvent(new Event('tixtab-native-preview'));
          setError('');
          setWarning(result.data.warning === 'font-replaced');
        }
      })()
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
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
  }, [source, page.id, page.sourceIndex, edits, pdfNight, scale, policy.basePixels]);
  useEffect(() => {
    const host = root.current;
    return () => {
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
          {t('暂存预览失败，请检查编辑参数后重试。')}
        </span>
      )}
    </>
  );
}
