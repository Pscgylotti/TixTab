import { useEffect, useState } from 'react';
export type HapticStatus = 'waiting' | 'supported' | 'unsupported' | 'unavailable';
export function usePenHaptics(tool: string) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem('tixtab.penHaptics') === 'true';
    } catch {
      return false;
    }
  });
  const [strength, setStrength] = useState(() => {
    try {
      const saved = localStorage.getItem('tixtab.penHapticStrength');
      const n = saved === null ? 0.5 : Number(saved);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
    } catch {
      return 0.5;
    }
  });
  useEffect(() => {
    void window.surfaceDesktop?.penHaptics?.run('intensity', strength).catch(() => {});
  }, [strength]);
  const [status, setStatus] = useState<HapticStatus>(
    window.surfaceDesktop?.penHaptics ? 'waiting' : 'unavailable',
  );
  useEffect(() => {
    const bridge = window.surfaceDesktop?.penHaptics;
    if (!bridge) return;
    let alive = true;
    const result = (state: HapticStatus) => {
      if (alive) setStatus(state);
    };
    const run = (action: 'start' | 'stop' | 'configure', value?: boolean | string) => {
      void bridge
        .run(action, value)
        .then(result)
        .catch(() => result('unavailable'));
    };
    const unsubscribe = bridge.onStatus(result);
    run('configure', enabled);
    let pointer: number | null = null;
    const stop = () => {
      if (pointer !== null) {
        pointer = null;
        run('stop');
      }
    };
    const down = (event: PointerEvent) => {
      if (!enabled || event.pointerType !== 'pen' || event.altKey || event.buttons & 2) return;
      const element = event.target instanceof Element ? event.target : null;
      if (
        !element ||
        element.closest(
          'button,input,textarea,select,.ink-selection-box,.object-selection,.pdf-native-layer,.pdf-navigation-layer',
        )
      )
        return;
      let kind = event.button === 5 || event.buttons & 32 ? 'eraser' : tool;
      if (element instanceof HTMLCanvasElement && element.closest('.formula-drawing'))
        kind = kind === 'eraser' ? kind : 'pen';
      else if (element instanceof HTMLCanvasElement && element.closest('.sketch-editor')) {
        if (kind !== 'eraser')
          kind = element
            .closest('.excalidraw')
            ?.querySelector('[data-testid="toolbar-eraser"]:checked')
            ? 'eraser'
            : element
                  .closest('.excalidraw')
                  ?.querySelector('[data-testid="toolbar-freedraw"]:checked')
              ? 'pen'
              : '';
      } else if (!element.closest('.page-editor')) return;
      if (!['pen', 'ballpoint', 'pencil', 'highlighter', 'eraser'].includes(kind)) return;
      pointer = event.pointerId;
      run('start', kind);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === pointer) stop();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', stop);
    return () => {
      alive = false;
      stop();
      unsubscribe();
      void bridge.run('configure', false).catch(() => {});
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', stop);
    };
  }, [enabled, tool]);
  return {
    enabled,
    status,
    strength,
    setStrength(value: number) {
      const n = Math.max(0, Math.min(1, value));
      setStrength(n);
      try {
        localStorage.setItem('tixtab.penHapticStrength', String(n));
      } catch {}
    },
    available: !!window.surfaceDesktop?.penHaptics,
    setEnabled(value: boolean) {
      setEnabled(value);
      try {
        localStorage.setItem('tixtab.penHaptics', String(value));
      } catch {}
    },
  };
}
