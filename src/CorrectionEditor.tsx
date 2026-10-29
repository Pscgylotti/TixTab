import { useEffect, useRef, useState } from 'react';
import { Crop, Grid3X3, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { t } from './i18n';
import type { CorrectionOptions, CorrectionPoint } from './localDocumentTools';

export const cornerDefaults = (): CorrectionPoint[] => [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
export const meshDefaults = (): CorrectionPoint[] =>
  Array.from({ length: 25 }, (_, i) => [(i % 5) / 4, Math.floor(i / 5) / 4]);

export default function CorrectionEditor({
  original,
  image,
  options,
  detected,
  disabled,
  onChange,
  onReset,
  onContinue,
}: {
  original: string;
  image?: string;
  options: CorrectionOptions;
  detected?: CorrectionPoint[] | null;
  disabled: boolean;
  onChange: (options: CorrectionOptions) => void;
  onReset: () => void;
  onContinue: () => void;
}) {
  const [tool, setTool] = useState<'corners' | 'mesh'>('corners');
  const [size, setSize] = useState({ width: 1000, height: 1000 });
  const [zoom, setZoom] = useState(1),
    [split, setSplit] = useState(50);
  const svg = useRef<SVGSVGElement>(null);
  const [pixelScale, setPixelScale] = useState(1);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const update = () => setPixelScale(Math.max(0.001, el.getScreenCTM()?.a || 1));
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [size, zoom]);
  const points =
    tool === 'corners'
      ? options.corners || detected || cornerDefaults()
      : options.mesh || meshDefaults();
  const move = (index: number, point: CorrectionPoint) => {
    const next = points.map((p, i) => (i === index ? point : p));
    onChange({
      ...options,
      method: 'manual',
      corners: tool === 'corners' ? next : undefined,
      mesh: tool === 'mesh' ? next : undefined,
    });
  };
  return (
    <div className="correction-editor">
      <div className="correction-editor-toolbar">
        <strong>{t('手动校准')}</strong>
        <button
          aria-pressed={tool === 'corners'}
          disabled={disabled}
          onClick={() => setTool('corners')}
        >
          <Crop size={16} />
          {t('四角')}
        </button>
        <button aria-pressed={tool === 'mesh'} disabled={disabled} onClick={() => setTool('mesh')}>
          <Grid3X3 size={16} />
          {t('曲面网格')}
        </button>
        <button aria-label={t('缩小校准图')} onClick={() => setZoom(Math.max(1, zoom - 0.5))}>
          <ZoomOut size={16} />
        </button>
        <button aria-label={t('放大校准图')} onClick={() => setZoom(Math.min(4, zoom + 0.5))}>
          <ZoomIn size={16} />
        </button>
        <button
          disabled={disabled}
          onClick={() => {
            setZoom(1);
            onReset();
          }}
        >
          <RotateCcw size={16} />
          {t('重置调整')}
        </button>
      </div>
      <p className="model-note">
        {t(
          tool === 'corners'
            ? '拖动四角贴合文档边缘；方向键微调，Shift 加速。'
            : '将网格点移到原图对应位置；弯曲的网格将展开为规则网格。',
        )}
      </p>
      <div className="correction-image-scroll">
        <div style={{ width: `${zoom * 100}%`, height: `${zoom * 36}dvh` }}>
          <svg
            ref={svg}
            className="correction-edit-canvas"
            viewBox={`0 0 ${size.width} ${size.height}`}
            aria-label={t('校准控制点')}
          >
            <image href={original} width={size.width} height={size.height} />
            {tool === 'corners' ? (
              <polygon
                className="correction-guide"
                points={points.map((p) => `${p[0] * size.width},${p[1] * size.height}`).join(' ')}
              />
            ) : (
              <>
                {Array.from({ length: 5 }, (_, row) => (
                  <polyline
                    key={`r${row}`}
                    className="correction-guide"
                    points={points
                      .slice(row * 5, row * 5 + 5)
                      .map((p) => `${p[0] * size.width},${p[1] * size.height}`)
                      .join(' ')}
                  />
                ))}
                {Array.from({ length: 5 }, (_, col) => (
                  <polyline
                    key={`c${col}`}
                    className="correction-guide"
                    points={points
                      .filter((_, i) => i % 5 === col)
                      .map((p) => `${p[0] * size.width},${p[1] * size.height}`)
                      .join(' ')}
                  />
                ))}
              </>
            )}
            {points.map((point, index) => (
              <g
                key={index}
                className="correction-control"
                transform={`translate(${point[0] * size.width} ${point[1] * size.height})`}
                tabIndex={disabled ? -1 : 0}
                role="slider"
                aria-label={t('校准点 {0}', index + 1)}
                aria-valuetext={`${Math.round(point[0] * 100)}%, ${Math.round(point[1] * 100)}%`}
                onKeyDown={(e) => {
                  if (
                    disabled ||
                    !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
                  )
                    return;
                  e.preventDefault();
                  e.stopPropagation();
                  const step = e.shiftKey ? 0.01 : 0.001;
                  move(index, [
                    Math.max(
                      0,
                      Math.min(
                        1,
                        point[0] +
                          (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0),
                      ),
                    ),
                    Math.max(
                      0,
                      Math.min(
                        1,
                        point[1] + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0),
                      ),
                    ),
                  ]);
                }}
                onPointerDown={(e) => {
                  if (disabled) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const matrix = svg.current?.getScreenCTM();
                  if (!matrix) return;
                  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
                  move(index, [
                    Math.max(0, Math.min(1, p.x / size.width)),
                    Math.max(0, Math.min(1, p.y / size.height)),
                  ]);
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
              >
                <circle className="correction-hit" r={18 / pixelScale} />
                <circle className="correction-handle" r={7 / pixelScale} />
              </g>
            ))}
          </svg>
        </div>
      </div>
      <img
        className="correction-size-probe"
        src={original}
        alt=""
        onLoad={(e) =>
          setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
        }
      />
      {image && (
        <>
          <div className="correction-comparison">
            <figure>
              <figcaption>{t('原图')}</figcaption>
              <img src={original} alt={t('矫正前')} />
            </figure>
            <figure>
              <figcaption>{t('矫正结果')}</figcaption>
              <img src={image} alt={t('矫正后')} />
            </figure>
          </div>
          <details>
            <summary>{t('叠加对比')}</summary>
            <div className="correction-overlay">
              <img src={original} alt="" />
              <img
                src={image}
                alt={t('矫正对比')}
                style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
              />
            </div>
            <input
              type="range"
              aria-label={t('前后对比分界')}
              min={0}
              max={100}
              value={split}
              onChange={(e) => setSplit(Number(e.target.value))}
            />
          </details>
          <button disabled={disabled} onClick={onContinue}>
            {t('在此结果上继续微调')}
          </button>
        </>
      )}
    </div>
  );
}
