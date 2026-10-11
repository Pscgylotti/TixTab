import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
export function useScrollViewport(root: RefObject<HTMLElement | null>) {
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 800, width: 0 });
  const measure = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const next = {
      top: el.scrollTop,
      left: el.scrollLeft,
      height: el.clientHeight,
      width: el.clientWidth,
    };
    setViewport((old) =>
      old.top === next.top &&
      old.left === next.left &&
      old.height === next.height &&
      old.width === next.width
        ? old
        : next,
    );
  }, [root]);
  useLayoutEffect(() => {
    const el = root.current!;
    let frame = 0;
    const changed = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    const observer = new ResizeObserver(changed);
    observer.observe(el);
    el.addEventListener('scroll', changed, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', changed);
      cancelAnimationFrame(frame);
    };
  }, [measure, root]);
  return [viewport, measure] as const;
}
