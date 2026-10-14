import { useSyncExternalStore } from 'react';
import { t as tr, useLocale } from './i18n';
import type { PenDiagnostic } from './PdfSurface';

/** Pen samples arrive many times a second while writing. Only the two small
 * readouts below subscribe, so a stroke never re-renders the application shell. */
let current: PenDiagnostic = { type: '', pressure: 0, eraser: false, samples: 0 };
const listeners = new Set<() => void>();
export function reportPenDiagnostic(next: PenDiagnostic) {
  current = next;
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function usePenDiagnostic() {
  useLocale();
  return useSyncExternalStore(subscribe, () => current);
}
export function PenStatus() {
  const diagnostic = usePenDiagnostic();
  return (
    <div className="row pen-status">
      <span className={`status-dot ${diagnostic.eraser ? 'orange' : ''}`} />
      <span>
        {diagnostic.eraser
          ? tr('背面笔擦')
          : diagnostic.type === 'pen'
            ? 'Surface Pen'
            : tr('笔输入就绪')}
      </span>
      <span className="status-separator" />
      <span>
        {tr('压感')}
        {diagnostic.pressure.toFixed(2)}
      </span>
      <span className="pressure-meter">
        <span style={{ width: `${diagnostic.pressure * 100}%` }} />
      </span>
    </div>
  );
}
export function PenDiagnosticCard() {
  const diagnostic = usePenDiagnostic();
  return (
    <div className="diagnostic-card">
      <span>{tr('最近输入')}</span>
      <strong>{diagnostic.type || tr('等待笔输入')}</strong>
      <span>{tr('原始压感')}</span>
      <strong>{diagnostic.pressure.toFixed(4)}</strong>
      <span>{tr('背面擦除')}</span>
      <strong>{diagnostic.eraser ? tr('已检测') : tr('未激活')}</strong>
      <span>{tr('当前笔划采样')}</span>
      <strong>{diagnostic.samples}</strong>
      <span>{tr('屏幕像素比例')}</span>
      <strong>{window.devicePixelRatio.toFixed(2)}×</strong>
    </div>
  );
}
