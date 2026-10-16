import { useLayoutEffect, useRef, useState } from 'react';
import { placeSelectionFlyout, type WritingHand, type ViewRect } from './selectionPlacement';
interface Anchor {
  x: number;
  y: number;
  range?: Range;
}
export function useSelectionPlacement(
  selection: Anchor,
  hand: WritingHand,
  expanded: boolean,
  enabled = true,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() =>
    placeSelectionFlyout(
      { left: 0, top: 0, width: innerWidth, height: innerHeight },
      { width: expanded ? 408 : 268, height: 54 },
      { left: selection.x, top: selection.y, width: 0, height: 0 },
      selection,
      hand,
      expanded,
    ),
  );
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = ref.current!;
    let frame = 0;
    const update = () => {
      frame = 0;
      const visual = window.visualViewport;
      const viewport: ViewRect = {
        left: visual?.offsetLeft ?? 0,
        top: visual?.offsetTop ?? 0,
        width: visual?.width ?? innerWidth,
        height: visual?.height ?? innerHeight,
      };
      // Toolbars, status bar and docked chat do not provide usable page space.
      const canvas = document.querySelector('.canvas-container')?.getBoundingClientRect();
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        const right = Math.min(viewport.left + viewport.width, canvas.right),
          bottom = Math.min(viewport.top + viewport.height, canvas.bottom);
        viewport.left = Math.max(viewport.left, canvas.left);
        viewport.top = Math.max(viewport.top, canvas.top);
        viewport.width = Math.max(1, right - viewport.left);
        viewport.height = Math.max(1, bottom - viewport.top);
      }
      // The custom keyboard does not resize the visual viewport. Treat its
      // actual bounds as an exclusion region, including after a drag/resize.
      const keyboard = document.querySelector('.touch-keyboard')?.getBoundingClientRect();
      const obstacles = Array.from(
        document.querySelectorAll<HTMLElement>('.insert-dock,.zoom-dock,.page-navigation'),
      )
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      if (keyboard) obstacles.push(keyboard);
      const anchor =
        !expanded && selection.range?.commonAncestorContainer.isConnected
          ? selection.range.getBoundingClientRect()
          : { left: selection.x, top: selection.y, width: 0, height: 0 };
      const actions = element.querySelector<HTMLElement>('.selection-actions');
      const style = getComputedStyle(element);
      const gap = actions ? parseFloat(getComputedStyle(actions).columnGap) || 0 : 0;
      const buttons = actions ? Array.from(actions.children) : [];
      const compactWidth = !expanded
        ? buttons.reduce((sum, button) => sum + button.getBoundingClientRect().width, 0) +
          Math.max(0, buttons.length - 1) * gap +
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth)
        : 0;
      const next = placeSelectionFlyout(
        viewport,
        {
          width: expanded ? 408 : Math.ceil(compactWidth || 268),
          height: element.scrollHeight + 2,
        },
        anchor,
        selection,
        hand,
        expanded,
        obstacles,
      );
      setPosition((previous) =>
        Object.keys(next).every(
          (key) => next[key as keyof typeof next] === previous[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) schedule();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    const canvas = document.querySelector('.canvas-container');
    if (canvas) observer.observe(canvas);
    const actions = element.querySelector('.selection-actions');
    const mutation = new MutationObserver(schedule);
    if (actions) {
      observer.observe(actions);
      mutation.observe(actions, { childList: true, subtree: true, characterData: true });
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('surfacetab-keyboard-layout', schedule);
    document.addEventListener('scroll', scroll, true);
    visualViewport?.addEventListener('resize', schedule);
    visualViewport?.addEventListener('scroll', schedule);
    update();
    return () => {
      observer.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('surfacetab-keyboard-layout', schedule);
      document.removeEventListener('scroll', scroll, true);
      visualViewport?.removeEventListener('resize', schedule);
      visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [selection, hand, expanded, enabled]);
  return { ref, position };
}
