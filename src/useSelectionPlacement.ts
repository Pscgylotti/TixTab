import { useLayoutEffect, useRef, useState } from 'react';
import { placeSelectionFlyout, type WritingHand, type ViewRect } from './selectionPlacement';
interface Anchor {
  x: number;
  y: number;
  range?: Range;
}
export function useSelectionPlacement(selection: Anchor, hand: WritingHand, expanded: boolean) {
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
      // The custom keyboard does not resize the visual viewport. Treat its
      // actual bounds as an exclusion region, including after a drag/resize.
      const keyboard = document.querySelector('.touch-keyboard')?.getBoundingClientRect();
      const anchor = selection.range?.commonAncestorContainer.isConnected
        ? selection.range.getBoundingClientRect()
        : { left: selection.x, top: selection.y, width: 0, height: 0 };
      const actions = element.querySelector<HTMLElement>('.selection-actions');
      const style = getComputedStyle(element);
      const gap = actions ? parseFloat(getComputedStyle(actions).columnGap) || 0 : 0;
      const buttons = actions ? Array.from(actions.children) : [];
      const compactWidth =
        buttons.reduce((sum, button) => sum + button.getBoundingClientRect().width, 0) +
        Math.max(0, buttons.length - 1) * gap +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth);
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
        keyboard ? [keyboard] : [],
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
  }, [selection, hand, expanded]);
  return { ref, position };
}
