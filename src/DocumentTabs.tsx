import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { File, X, PanelRightClose, XCircle } from 'lucide-react';
import { t, useLocale } from './i18n';
import AnchoredPopover from './AnchoredPopover';
import { tabsToClose, type DocumentTab, type CloseTabsMode } from './tabOperations';
type Contact = {
  pointerId: number;
  id: string;
  type: string;
  x: number;
  y: number;
  lastX: number;
  held: boolean;
  mode: 'pending' | 'pan' | 'drag';
  slot: number;
};
export default function DocumentTabs({
  tabs,
  activeId,
  disabled,
  onSelect,
  onClose,
  onReorder,
  children,
}: {
  tabs: DocumentTab[];
  activeId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string, mode: CloseTabsMode) => void;
  onReorder: (id: string, slot: number) => void;
  children: ReactNode;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null),
    contact = useRef<Contact | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    frame = useRef(0),
    suppress = useRef(0);
  const current = useRef({ tabs, disabled, onReorder });
  current.current = { tabs, disabled, onReorder };
  const [drag, setDrag] = useState<{ id: string; slot: number } | null>(null),
    [menu, setMenu] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const cleanup = () => {
    clearTimeout(timer.current);
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const old = contact.current;
    contact.current = null;
    if (old) {
      const button = root.current?.querySelector<HTMLButtonElement>(
        `[data-tab-button="${CSS.escape(old.id)}"]`,
      );
      if (button?.hasPointerCapture(old.pointerId)) button.releasePointerCapture(old.pointerId);
    }
    setDrag(null);
  };
  const cancel = () => {
    if (contact.current) suppress.current = performance.now() + 700;
    cleanup();
    setMenu(null);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && contact.current) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(frame.current);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  const signature = tabs.map((tab) => tab.id).join(',');
  useEffect(() => {
    cancel();
  }, [signature, disabled]);
  const target = (x: number) => {
    const buttons = root.current?.querySelectorAll<HTMLElement>('.document-tab');
    if (!buttons) return 0;
    let slot = buttons.length;
    for (let i = 0; i < buttons.length; i++) {
      const r = buttons[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        slot = i;
        break;
      }
    }
    return slot;
  };
  const showMenu = (id: string, element: HTMLElement) => {
    if (current.current.disabled) return;
    setMenu({ id, anchor: element.getBoundingClientRect() });
  };
  const autoScroll = () => {
    frame.current = 0;
    const c = contact.current,
      el = root.current;
    if (!c || c.mode !== 'drag' || !el) return;
    const r = el.getBoundingClientRect(),
      edge = 32,
      speed =
        c.lastX < r.left + edge
          ? -Math.min(14, (r.left + edge - c.lastX) / 2)
          : c.lastX > r.right - edge
            ? Math.min(14, (c.lastX - r.right + edge) / 2)
            : 0;
    if (!speed) return;
    const old = el.scrollLeft;
    el.scrollLeft += speed;
    if (el.scrollLeft !== old) {
      c.slot = target(c.lastX);
      setDrag({ id: c.id, slot: c.slot });
      frame.current = requestAnimationFrame(autoScroll);
    }
  };
  const down = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (disabled || event.button !== 0) return;
    cleanup();
    setMenu(null);
    const c: Contact = {
      pointerId: event.pointerId,
      id,
      type: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      held: false,
      mode: 'pending',
      slot: 0,
    };
    contact.current = c;
    event.currentTarget.setPointerCapture(event.pointerId);
    const button = event.currentTarget;
    timer.current = setTimeout(() => {
      if (contact.current !== c || c.mode !== 'pending') return;
      c.held = true;
      suppress.current = performance.now() + 700;
      showMenu(id, button);
    }, 450);
  };
  const move = (event: ReactPointerEvent) => {
    const c = contact.current;
    if (!c || c.pointerId !== event.pointerId || disabled) return;
    const distance = Math.hypot(event.clientX - c.x, event.clientY - c.y);
    if (c.mode === 'pending' && distance > 8) {
      clearTimeout(timer.current);
      c.mode = c.type === 'mouse' || c.held ? 'drag' : 'pan';
      setMenu(null);
      suppress.current = performance.now() + 700;
    }
    if (c.mode === 'drag') {
      event.preventDefault();
      c.lastX = event.clientX;
      c.slot = target(event.clientX);
      setDrag((old) =>
        old?.id === c.id && old.slot === c.slot ? old : { id: c.id, slot: c.slot },
      );
      if (!frame.current) frame.current = requestAnimationFrame(autoScroll);
    } else if (c.mode === 'pan') {
      event.preventDefault();
      root.current!.scrollLeft -= event.clientX - c.lastX;
    }
    c.lastX = event.clientX;
  };
  const end = (event: ReactPointerEvent, cancelled = false) => {
    const c = contact.current;
    if (!c || c.pointerId !== event.pointerId) return;
    if (c.held || c.mode !== 'pending') suppress.current = performance.now() + 700;
    cleanup();
    if (!cancelled && c.mode === 'drag' && !current.current.disabled)
      current.current.onReorder(c.id, c.slot);
  };
  const anchorTab = menu ? tabs.find((tab) => tab.id === menu.id) : undefined;
  return (
    <>
      <div
        className="document-tabs"
        role="tablist"
        aria-label={t('文档标签页')}
        ref={root}
        onWheel={() => setMenu(null)}
        onPointerMove={move}
        onPointerUp={(e) => end(e)}
        onPointerCancel={(e) => end(e, true)}
        onLostPointerCapture={(e) => end(e, true)}
      >
        {tabs.map((tab, i) => (
          <div
            className={`document-tab ${tab.id === activeId ? 'active' : ''} ${drag?.id === tab.id ? 'tab-dragging' : ''}`}
            key={tab.id}
            data-tab-id={tab.id}
          >
            {drag && (drag.slot === i || (i === tabs.length - 1 && drag.slot === tabs.length)) && (
              <span
                className={`tab-insertion-line ${drag.slot === tabs.length ? 'after' : ''}`}
                data-tab-insertion={drag.slot}
                aria-hidden="true"
              />
            )}
            <button
              role="tab"
              aria-selected={tab.id === activeId}
              disabled={disabled}
              title={tab.name}
              draggable={false}
              data-tab-button={tab.id}
              onPointerDown={(e) => down(e, tab.id)}
              onClick={() => {
                if (performance.now() > suppress.current) onSelect(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (contact.current?.type !== 'mouse' && contact.current?.held) return;
                cleanup();
                suppress.current = performance.now() + 700;
                showMenu(tab.id, e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault();
                  e.stopPropagation();
                  showMenu(tab.id, e.currentTarget);
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLButtonElement>(
                        '.document-tab-menu > button:not(:disabled)',
                      )
                      ?.focus(),
                  );
                  return;
                }
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                  e.preventDefault();
                  e.stopPropagation();
                  const next =
                    e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? tabs.length - 1
                        : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                  root.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
                  onSelect(tabs[next].id);
                }
              }}
            >
              <File size={14} />
              <span>{tab.name}</span>
            </button>
            <button
              className="close-tab"
              aria-label={t('关闭标签 {0}', tab.name)}
              title={t('关闭标签，保留文档')}
              disabled={disabled}
              onClick={() => onClose(tab.id, 'current')}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {children}
      </div>
      {menu && anchorTab && !disabled && (
        <AnchoredPopover
          anchor={menu.anchor}
          label={t('标签页操作')}
          width={220}
          className="document-tab-popover"
          onClose={() => setMenu(null)}
        >
          <div
            className="document-tab-menu"
            role="menu"
            aria-label={t('标签页操作')}
            onKeyDown={(event) => {
              if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
              ];
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }}
          >
            {(
              [
                ['current', '关闭当前标签', X],
                ['others', '关闭其它标签', XCircle],
                ['right', '关闭右侧所有标签', PanelRightClose],
              ] as const
            ).map(([mode, label, Icon]) => (
              <button
                key={mode}
                role="menuitem"
                disabled={!tabsToClose(tabs, menu.id, mode).length}
                onClick={() => {
                  const id = menu.id;
                  setMenu(null);
                  onClose(id, mode);
                }}
              >
                <Icon size={16} />
                {t(label)}
              </button>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </>
  );
}
