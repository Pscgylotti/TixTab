import { useRef, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { t } from './i18n';
import {
  getPressureCurve,
  savePressureCurve,
  LINEAR_PRESSURE,
  MAX_PRESSURE_POINTS,
  type PressurePoint,
} from './pressureCurve';

export default function PressureCurveSettings() {
  const [points, setPoints] = useState(getPressureCurve),
    [selected, select] = useState(-1);
  const current = useRef(points),
    drag = useRef<{ id: number; index: number; before: readonly PressurePoint[] } | null>(null);
  const update = (next: readonly PressurePoint[], commit = false) => {
    current.current = next;
    setPoints(next);
    if (commit) savePressureCurve(next);
  };
  const coordinate = (event: React.PointerEvent<SVGSVGElement>): PressurePoint => {
    const r = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (((event.clientX - r.left) / r.width) * 300 - 24) / 260)),
      Math.max(0, Math.min(1, (166 - ((event.clientY - r.top) / r.height) * 190) / 148)),
    ];
  };
  const remove = () => {
    if (selected > 0 && selected < points.length - 1) {
      update(
        points.filter((_, i) => i !== selected),
        true,
      );
      select(-1);
    }
  };
  return (
    <details className="native-settings pressure-curve-settings">
      <summary>{t('压感曲线')}</summary>
      <div className="pressure-curve-actions">
        <span>{t('分割点 {0} / 16', points.length - 2)}</span>
        <button
          className="icon-button"
          aria-label={t('删除分割点')}
          disabled={selected <= 0 || selected >= points.length - 1}
          onClick={remove}
        >
          <Trash2 size={16} />
        </button>
        <button
          className="icon-button"
          aria-label={t('恢复线性压感')}
          onClick={() => {
            update(LINEAR_PRESSURE, true);
            select(-1);
          }}
        >
          <RotateCcw size={16} />
        </button>
      </div>
      <svg
        className="pressure-curve-graph"
        viewBox="0 0 300 190"
        role="group"
        aria-label={t('压感曲线编辑器')}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          const [x, y] = coordinate(event);
          let index = current.current.findIndex(
            ([px, py]) => Math.hypot((px - x) * 260, (py - y) * 148) < 12,
          );
          const before = current.current;
          if (index < 0) {
            if (
              before.length >= MAX_PRESSURE_POINTS + 2 ||
              x < 0.005 ||
              x > 0.995 ||
              before.some(([px]) => Math.abs(px - x) < 0.005)
            )
              return;
            const next = [...before, [x, y] as PressurePoint].sort((a, b) => a[0] - b[0]);
            index = next.findIndex(([px]) => px === x);
            update(next);
          }
          select(index);
          if (index === 0 || index === current.current.length - 1) return;
          drag.current = { id: event.pointerId, index, before };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.id !== event.pointerId) return;
          const [x, y] = coordinate(event),
            list = current.current;
          const next = list.map((p, i) =>
            i === active.index
              ? ([
                  Math.max(list[i - 1][0] + 0.001, Math.min(list[i + 1][0] - 0.001, x)),
                  y,
                ] as PressurePoint)
              : p,
          );
          update(next);
        }}
        onPointerUp={(event) => {
          if (drag.current?.id === event.pointerId) {
            savePressureCurve(current.current);
            drag.current = null;
          }
        }}
        onPointerCancel={() => {
          if (drag.current) update(drag.current.before);
          drag.current = null;
        }}
      >
        <path d="M24 18V166H284 M24 166L284 18" className="pressure-curve-guide" />
        <text x="2" y="20">
          100%
        </text>
        <text x="4" y="180">
          0
        </text>
        <text x="253" y="184">
          100%
        </text>
        <polyline points={points.map(([x, y]) => `${24 + x * 260},${166 - y * 148}`).join(' ')} />
        {points.map(([x, y], i) => (
          <circle
            key={i}
            cx={24 + x * 260}
            cy={166 - y * 148}
            r={selected === i ? 5 : 4}
            tabIndex={i > 0 && i < points.length - 1 ? 0 : -1}
            role="button"
            aria-label={t('压感点：输入 {0}%，输出 {1}%', Math.round(x * 100), Math.round(y * 100))}
            onFocus={() => select(i)}
            onKeyDown={(e) => {
              if (i <= 0 || i >= points.length - 1) return;
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                update(
                  points.filter((_, n) => n !== i),
                  true,
                );
                select(-1);
              }
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                const step = e.shiftKey ? 0.05 : 0.01;
                const nx = Math.max(
                  points[i - 1][0] + 0.001,
                  Math.min(
                    points[i + 1][0] - 0.001,
                    x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0),
                  ),
                );
                const ny = Math.max(
                  0,
                  Math.min(1, y + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0)),
                );
                update(
                  points.map((p, n) => (n === i ? ([nx, ny] as PressurePoint) : p)),
                  true,
                );
              }
            }}
          />
        ))}
      </svg>
      {selected >= 0 && points[selected] && (
        <output>
          {t(
            '输入 {0}% → 输出 {1}%',
            Math.round(points[selected][0] * 100),
            Math.round(points[selected][1] * 100),
          )}
        </output>
      )}
      <p className="appearance-note">
        {t('点击添加，拖动调整。最多 16 个分割点，仅影响之后的新笔迹。')}
      </p>
    </details>
  );
}
