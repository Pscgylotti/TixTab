import { connectNativeTexo } from './nativeTexo';
import { noteNativeModel } from './nativeResources';
import { getModelIdleSeconds } from './modelIdle';
import { createOcrSession } from './ocrWorkerSession';
import type { BitmapRecognition } from './bitmapOcr';
import { t } from './i18n';
export type TesseractVariant = 'fast' | 'best' | 'mixed-best';

/** One English layout-only worker per scan. No CPU neural recognition and no
 * document-wide pixel collection: the service owns the 16-slot line queue. */
export async function withQueuedNpuTesseract<T>(
  variant: TesseractVariant,
  batch: number,
  signal: AbortSignal,
  work: (recognize: (image: string, lane: number) => Promise<BitmapRecognition>) => Promise<T>,
) {
  const health = await connectNativeTexo(signal);
  signal.throwIfAborted();
  if (
    !health.capabilities?.includes('tesseract-npu-queue-v1') ||
    (variant === 'mixed-best' && !health.capabilities.includes('tesseract-npu-mixed-v1'))
  )
    throw new Error(t('请更新本地运行时服务以使用 NPU Tesseract'));
  if (!health.devices.some((d) => d.id.split('.')[0] === 'NPU'))
    throw new Error(t('未检测到 NPU；请选择其它 OCR 后端'));
  noteNativeModel(!!health.capabilities.includes('release-idle'));
  const layout = createOcrSession(false, true, variant === 'mixed-best' ? 'chi_sim+eng' : 'eng');
  try {
    return await work(async (image) => {
      signal.throwIfAborted();
      const started = performance.now();
      const result = await layout.localOcr(image, () => {}, signal);
      const layoutMs = performance.now() - started;
      const boxes: number[][] = [];
      for (const block of result.layoutBlocks ?? [])
        for (const paragraph of block.paragraphs ?? [])
          for (const line of paragraph.lines ?? []) {
            const b = line.bbox;
            if (b && [b.x0, b.y0, b.x1, b.y1].every(Number.isInteger))
              boxes.push([b.x0, b.y0, b.x1, b.y1]);
          }
      if (boxes.length > 2048) throw new Error(t('图片文本行过多，请缩小扫描范围'));
      const response = await fetch('http://127.0.0.1:8766/ocr-tesseract-npu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image,
          boxes,
          variant,
          batch,
          idleReleaseSeconds: getModelIdleSeconds(),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
      });
      const data = await response.json();
      signal.throwIfAborted();
      if (!response.ok)
        throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
      if (
        data.device !== 'NPU' ||
        typeof data.text !== 'string' ||
        data.text.length > 100000 ||
        !Array.isArray(data.lines) ||
        data.lines.length > 4096 ||
        !data.lines.every(
          (l: { text?: unknown; polygon?: unknown }) =>
            typeof l.text === 'string' &&
            l.text.length <= 10000 &&
            Array.isArray(l.polygon) &&
            l.polygon.length === 8 &&
            l.polygon.every(
              (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 8192,
            ),
        )
      )
        throw new Error(t('NPU OCR 返回格式无效'));
      return {
        text: data.text,
        lines: data.lines,
        engine: `Tesseract ${variant} · NPU (experimental)`,
        timing: {
          totalMs: performance.now() - started,
          layoutMs,
          ...Object.fromEntries(
            ['inferenceMs', 'compileMs', 'serviceMs'].flatMap((key) =>
              typeof data.timing?.[key] === 'number' &&
              Number.isFinite(data.timing[key]) &&
              data.timing[key] >= 0
                ? [[key, data.timing[key]]]
                : [],
            ),
          ),
        },
      };
    });
  } finally {
    layout.releaseOcr();
  }
}
