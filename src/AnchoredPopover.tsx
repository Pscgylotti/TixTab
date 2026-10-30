import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
export default function AnchoredPopover({
  anchor,
  label,
  onClose,
  children,
  width = 300,
  className = '',
  alert = false,
}: {
  anchor: DOMRect | HTMLElement;
  label: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  className?: string;
  alert?: boolean;
}) {
  const root = useRef<HTMLElement>(null),
    [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const measure = () => {
      if (anchor instanceof HTMLElement && !anchor.isConnected) {
        onClose();
        return;
      }
      const bounds = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
      const r = root.current!.getBoundingClientRect(),
        left = Math.max(
          8,
          Math.min(window.innerWidth - r.width - 8, bounds.left + bounds.width / 2 - r.width / 2),
        ),
        below = window.innerHeight - bounds.bottom - 8,
        above = bounds.top - 8;
      const top =
        below >= r.height
          ? bounds.bottom + 6
          : above >= r.height
            ? bounds.top - r.height - 6
            : Math.max(8, Math.min(window.innerHeight - r.height - 8, bounds.bottom + 6));
      setPosition({ left, top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root.current!);
    if (anchor instanceof HTMLElement) observer.observe(anchor);
    window.addEventListener('resize', measure);
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <section
      ref={root}
      className={`editing-dialog anchored-popover ${className}`}
      role={alert ? 'alertdialog' : 'dialog'}
      aria-label={label}
      style={{
        left: position.left,
        top: position.top,
        width: Math.min(width, window.innerWidth - 16),
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') onClose();
      }}
    >
      {children}
    </section>,
    document.body,
  );
}
