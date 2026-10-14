import { useLayoutEffect, useRef, useState } from 'react';
import { PdfBitmapDisplay } from './pdfBitmapDisplay';

export function usePdfBitmapDisplay(className = '') {
  const host = useRef<HTMLDivElement>(null);
  const display = useRef<PdfBitmapDisplay | null>(null);
  const [recovery, setRecovery] = useState(0);
  useLayoutEffect(() => {
    const mounted = new PdfBitmapDisplay(host.current!, className, () => setRecovery((n) => n + 1));
    display.current = mounted;
    return () => {
      mounted.dispose();
      display.current = null;
    };
  }, [className]);
  return { host, display, recovery };
}
