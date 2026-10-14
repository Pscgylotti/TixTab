import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';

type Field = HTMLInputElement | HTMLTextAreaElement;
type Command = 'selectAll' | 'cut' | 'copy' | 'paste';
const items = [
  ['selectAll', '全选'],
  ['cut', '剪切'],
  ['copy', '复制'],
  ['paste', '粘贴'],
] as const;
const isField = (el: EventTarget | null): el is Field =>
  !!el &&
  ((el as HTMLElement).tagName === 'TEXTAREA' ||
    ((el as HTMLElement).tagName === 'INPUT' &&
      ['text', 'search', 'email', 'url', 'password', 'tel'].includes(
        (el as HTMLInputElement).type,
      )));

/** No field contents cross this UI boundary; native edit commands retain normal undo/paste. */
export default function FieldEditMenu({
  hostDocument,
  onCommand,
}: {
  hostDocument: Document;
  onCommand: (command: Command) => Promise<void>;
}) {
  const [menu, setMenu] = useState<{ field: Field; x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let contact: { id: number; x: number; y: number } | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      contact = undefined;
    };
    const show = (field: Field, x: number, y: number) => {
      if (field.disabled || !field.isConnected) return;
      field.focus({ preventScroll: true });
      const rect = field.getBoundingClientRect();
      setMenu({ field, x: x || rect.left, y: y || rect.bottom });
    };
    const down = (e: PointerEvent) => {
      cancel();
      if (root.current?.contains(e.target as Node)) return;
      setMenu(null);
      if (!isField(e.target) || e.target.disabled || e.pointerType === 'mouse' || e.button !== 0)
        return;
      const field = e.target;
      contact = { id: e.pointerId, x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        show(field, e.clientX, e.clientY);
      }, 500);
    };
    const move = (e: PointerEvent) => {
      if (
        contact?.id === e.pointerId &&
        Math.hypot(e.clientX - contact.x, e.clientY - contact.y) > 10
      )
        cancel();
    };
    const context = (e: MouseEvent) => {
      if (!isField(e.target) || e.target.disabled) return;
      e.preventDefault();
      cancel();
      show(e.target, e.clientX, e.clientY);
    };
    const hide = () => {
      cancel();
      setMenu(null);
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') hide();
    };
    hostDocument.addEventListener('pointerdown', down, true);
    hostDocument.addEventListener('pointermove', move, true);
    hostDocument.addEventListener('pointerup', cancel, true);
    hostDocument.addEventListener('pointercancel', cancel, true);
    hostDocument.addEventListener('contextmenu', context);
    hostDocument.addEventListener('scroll', hide, true);
    hostDocument.addEventListener('keydown', keys, true);
    hostDocument.defaultView?.addEventListener('blur', hide);
    return () => {
      cancel();
      hostDocument.removeEventListener('pointerdown', down, true);
      hostDocument.removeEventListener('pointermove', move, true);
      hostDocument.removeEventListener('pointerup', cancel, true);
      hostDocument.removeEventListener('pointercancel', cancel, true);
      hostDocument.removeEventListener('contextmenu', context);
      hostDocument.removeEventListener('scroll', hide, true);
      hostDocument.removeEventListener('keydown', keys, true);
      hostDocument.defaultView?.removeEventListener('blur', hide);
    };
  }, [hostDocument]);
  if (!menu || !menu.field.isConnected) return null;
  const view = hostDocument.defaultView!;
  const selected = menu.field.selectionStart !== menu.field.selectionEnd;
  return createPortal(
    <div
      ref={root}
      className="field-edit-menu"
      role="menu"
      aria-label={t('文本编辑')}
      style={{
        left: Math.max(8, Math.min(menu.x, view.innerWidth - 296)),
        top: Math.max(8, Math.min(menu.y - 52, view.innerHeight - 60)),
      }}
      onPointerDown={(e) => e.preventDefault()}
    >
      {items.map(([command, label]) => (
        <button
          key={command}
          role="menuitem"
          disabled={
            command === 'paste'
              ? menu.field.readOnly
              : command === 'cut' || command === 'copy'
                ? !selected ||
                  menu.field.type === 'password' ||
                  (command === 'cut' && menu.field.readOnly)
                : !menu.field.value.length
          }
          onClick={async () => {
            if (!menu.field.isConnected) {
              setMenu(null);
              return;
            }
            menu.field.focus({ preventScroll: true });
            await onCommand(command);
            if (command === 'selectAll') setMenu({ ...menu });
            else setMenu(null);
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>,
    hostDocument.body,
  );
}
