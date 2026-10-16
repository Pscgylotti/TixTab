import { t as tr, useLocale } from './i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Keyboard from 'simple-keyboard';
import DictationButton from './DictationButton';
import { copyText } from './clipboard';
import FieldEditMenu from './FieldEditMenu';
import { useNativeKeyboard, setNativeKeyboard } from './nativeKeyboard';
import { moveTextSelection, type EditKey } from './keyboardSelection';
import './chat.css';
import {
  Keyboard as KeyboardIcon,
  X,
  GripHorizontal,
  Settings2,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Delete,
  ClipboardList,
} from 'lucide-react';
import 'simple-keyboard/build/css/index.css';

type Field = HTMLInputElement | HTMLTextAreaElement;
type Mode = 'latex' | 'en' | 'pinyin' | 'voice';
type Candidate = { word: string; matchedLength: number };
const shortcuts = [
  ['selectAll', 'A', '全选'],
  ['cut', 'X', '剪切'],
  ['copy', 'C', '复制'],
  ['paste', 'V', '粘贴'],
  ['undo', 'Z', '撤销'],
  ['redo', 'Y', '重做'],
] as const;
const latex = {
  default: [
    '{esc} 1 2 3 4 5 6 7 8 9 0 {bksp}',
    '{tab} q w e r t y u i o p',
    'a s d f g h j k l',
    '{shift} z x c v b n m {enter}',
    '{ctrl} \\ ^ _ { } ( ) + - = {space} {left} {right}',
  ],
  shift: [
    '{esc} ! @ # $ % ^ & * ( ) {bksp}',
    '{tab} Q W E R T Y U I O P',
    'A S D F G H J K L',
    '{shift} Z X C V B N M {enter}',
    '{ctrl} | ~ _ [ ] < > * / + {space} {left} {right}',
  ],
};
const english = {
  default: [
    '{esc} 1 2 3 4 5 6 7 8 9 0 {bksp}',
    '{tab} q w e r t y u i o p',
    "a s d f g h j k l ; '",
    '{shift} z x c v b n m , . / {enter}',
    '{ctrl} ` - = [ ] \\ {space} {left} {right}',
  ],
  shift: [
    '{esc} ! @ # $ % ^ & * ( ) {bksp}',
    '{tab} Q W E R T Y U I O P',
    'A S D F G H J K L : "',
    '{shift} Z X C V B N M < > ? {enter}',
    '{ctrl} ~ _ + { } | {space} {left} {right}',
  ],
};
function editable(el: EventTarget | null): el is Field {
  return (
    (el as HTMLElement | null)?.tagName === 'TEXTAREA' ||
    ((el as HTMLElement | null)?.tagName === 'INPUT' &&
      ['text', 'search', 'email', 'url', 'password', 'tel'].includes((el as HTMLInputElement).type))
  );
}
function selection(el: Field, start: number, end = start) {
  try {
    el.setSelectionRange(start, end);
  } catch {
    /* Email fields do not expose a selection API. */
  }
}

export default function TouchKeyboard({
  chatOpen = false,
  hostDocument = document,
  onModels,
}: {
  chatOpen?: boolean;
  hostDocument?: Document;
  onModels?: () => void;
}) {
  const view = hostDocument.defaultView ?? window;
  const locale = useLocale();
  const [open, setOpen] = useState(false),
    [width, setWidth] = useState(
      () => Number(localStorage.getItem('surfacetab.keyboardWidth')) || 480,
    );
  const native = useNativeKeyboard();
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem('surfacetab.keyboardMode');
    return saved === 'en' || saved === 'pinyin' || saved === 'voice' ? saved : 'latex';
  });
  const [fieldReady, setFieldReady] = useState(false),
    [voiceStatus, setVoiceStatus] = useState('');
  const [shortcutError, setShortcutError] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [settings, setSettings] = useState(false),
    [position, setPosition] = useState({ x: 20, y: Math.max(70, view.innerHeight - 310) });
  const [right, setRight] = useState(10),
    [dock, setDock] = useState<Element | null>(null);
  const [composition, setComposition] = useState(''),
    [candidates, setCandidates] = useState<Candidate[]>([]),
    [candidatePage, setCandidatePage] = useState(0),
    [imeStatus, setImeStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const panel = useRef<HTMLElement>(null),
    host = useRef<HTMLDivElement>(null),
    keyboard = useRef<Keyboard | null>(null),
    field = useRef<Field | null>(null),
    pointerType = useRef('mouse'),
    shifted = useRef(false),
    controlled = useRef(false);
  const worker = useRef<Worker | null>(null),
    input = useRef(''),
    request = useRef(0),
    deferred = useRef<string | null>(null),
    ready = useRef(false),
    resolved = useRef(false);
  const insertRef = useRef<(key: string) => void>(() => {}),
    acceptRef = useRef<(item?: Candidate, suffix?: string) => void>(() => {});
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const layout = mode === 'latex' ? latex : english;
  const updateComposition = (value: string) => {
    input.current = value;
    deferred.current = null;
    resolved.current = false;
    setComposition(value);
    setCandidates([]);
    setCandidatePage(0);
    request.current++;
    if (ready.current) worker.current?.postMessage({ id: request.current, input: value });
  };
  useLayoutEffect(() => {
    view.dispatchEvent(new Event('surfacetab-keyboard-layout'));
  }, [open, width, position, settings, locale, mode, composition, candidates.length]);
  useLayoutEffect(() => {
    const workspace = hostDocument.querySelector('.workspace');
    const measure = () => {
      const chat = chatOpen ? hostDocument.querySelector('.chat-panel') : null,
        rect = chat?.getBoundingClientRect();
      // A narrow overlay leaves no room beside it. Use a reserved compose slot.
      setDock(rect && rect.left < 60 ? chat!.querySelector('.chat-keyboard-slot') : null);
      setRight(rect ? Math.max(10, view.innerWidth - rect.left + 8) : 10);
    };
    const observer = new ResizeObserver(measure),
      mutations = new MutationObserver(() => {
        const chat = hostDocument.querySelector('.chat-panel');
        if (chat) observer.observe(chat);
        measure();
      });
    if (workspace) {
      observer.observe(workspace);
      mutations.observe(workspace, { childList: true });
    }
    const chat = hostDocument.querySelector('.chat-panel');
    if (chat) observer.observe(chat);
    view.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      view.removeEventListener('resize', measure);
    };
  }, [chatOpen, hostDocument]);
  useEffect(() => {
    const attributes = new Map<Field, string | null>();
    const restore = (el: Field, old: string | null) => {
      if (el.getAttribute('inputmode') !== 'none') return;
      if (old === null) el.removeAttribute('inputmode');
      else el.setAttribute('inputmode', old);
    };
    const prepareField = (el: EventTarget | null) => {
      if (
        !native &&
        editable(el) &&
        !el.closest('.touch-keyboard') &&
        el.getAttribute('inputmode') !== 'none'
      ) {
        if (!attributes.has(el)) attributes.set(el, el.getAttribute('inputmode'));
        el.setAttribute('inputmode', 'none');
      }
    };
    const prepare = () => {
      setFieldReady(
        !!field.current?.isConnected && !field.current.disabled && !field.current.readOnly,
      );
      for (const [el, old] of attributes)
        if (!el.isConnected) {
          restore(el, old);
          attributes.delete(el);
        }
      for (const el of hostDocument.querySelectorAll('input,textarea')) prepareField(el);
    };
    prepare();
    const observer = new MutationObserver(prepare);
    observer.observe(hostDocument.body, { childList: true, subtree: true });
    const pointer = (e: PointerEvent) => {
      prepareField(e.target);
      pointerType.current = e.pointerType;
      if (editable(e.target) && !e.target.closest('.touch-keyboard')) updateComposition('');
    };
    const focus = (e: FocusEvent) => {
      prepareField(e.target);
      if (editable(e.target) && !e.target.closest('.touch-keyboard')) {
        if (field.current !== e.target) updateComposition('');
        field.current = e.target;
        setSelecting(false);
        setFieldReady(!e.target.disabled && !e.target.readOnly);
        if (!native && pointerType.current !== 'mouse') setOpen(true);
      }
    };
    hostDocument.addEventListener('pointerdown', pointer, true);
    hostDocument.addEventListener('focusin', focus, true);
    return () => {
      observer.disconnect();
      hostDocument.removeEventListener('pointerdown', pointer, true);
      hostDocument.removeEventListener('focusin', focus, true);
      for (const [el, old] of attributes) restore(el, old);
      attributes.clear();
    };
  }, [native, hostDocument]);
  const write = (content: string, backspace = false) => {
    const el = field.current;
    if (!el?.isConnected || el.disabled || el.readOnly) return;
    const start = el.selectionStart ?? el.value.length,
      end = el.selectionEnd ?? start;
    const from =
      backspace && start === end
        ? start - (Array.from(el.value.slice(0, start)).at(-1)?.length ?? 0)
        : start;
    if (el.maxLength >= 0)
      content = content.slice(0, Math.max(0, el.maxLength - (el.value.length - (end - from))));
    const next = el.value.slice(0, from) + content + el.value.slice(end);
    // Native editing records undo history; assigning value directly does not.
    el.focus({ preventScroll: true });
    selection(el, from, end);
    if (hostDocument.execCommand('insertText', false, content)) return;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus({ preventScroll: true });
    selection(el, from + content.length);
  };
  const shortcut = async (command: (typeof shortcuts)[number][0], key: string) => {
    setShortcutError('');
    if (input.current) accept();
    const active = hostDocument.activeElement;
    const target = editable(active)
      ? active
      : active?.closest('.touch-keyboard') && field.current?.isConnected
        ? field.current
        : null;
    if (target) target.focus({ preventScroll: true });
    // Object copy/cut and PDF undo/redo are handled by application key listeners.
    if (
      !target &&
      !active?.closest('[contenteditable="true"]') &&
      ['cut', 'copy', 'undo', 'redo'].includes(command)
    ) {
      const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        shiftKey: command === 'redo' && key === 'z',
        bubbles: true,
        cancelable: true,
      });
      hostDocument.body.dispatchEvent(event);
      if (event.defaultPrevented || command === 'undo' || command === 'redo') return;
    }
    try {
      if (view.surfaceDesktop?.editCommand) {
        if (!(await view.surfaceDesktop.editCommand(command))) throw Error('edit');
        return;
      }
      if (command === 'selectAll' && target) {
        selection(target, 0, target.value.length);
        return;
      }
      if ((command === 'cut' || command === 'copy') && target) {
        const start = target.selectionStart ?? 0,
          end = target.selectionEnd ?? start;
        if (target.type === 'password' || start === end) return;
        await copyText(target.value.slice(start, end));
        if (command === 'cut' && !target.readOnly && !target.disabled) {
          if (
            hostDocument.activeElement !== target ||
            target.selectionStart !== start ||
            target.selectionEnd !== end
          )
            return;
          field.current = target;
          write('');
        }
        return;
      }
      if (command === 'paste') {
        if (target) {
          const text = await view.navigator.clipboard.readText();
          if (!target.isConnected || hostDocument.activeElement !== target) return;
          field.current = target;
          write(text);
        } else if (active?.closest('[contenteditable="true"]')) {
          const text = await view.navigator.clipboard.readText();
          if (
            hostDocument.activeElement === active &&
            !hostDocument.execCommand('insertText', false, text)
          )
            throw Error('edit');
        } else {
          const data = new DataTransfer();
          for (const item of await view.navigator.clipboard.read())
            for (const type of item.types)
              if (type === 'text/plain' || type === 'text/html')
                data.setData(type, await (await item.getType(type)).text());
              else if (type === 'image/png')
                data.items.add(new File([await item.getType(type)], 'Clipboard.png', { type }));
          hostDocument.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }
      } else if (!hostDocument.execCommand(command)) throw Error('edit');
    } catch {
      setShortcutError(tr('快捷操作失败，请重试或检查剪贴板权限。'));
    }
  };
  const accept = (item?: Candidate, suffix?: string) => {
    const raw = input.current,
      remaining = item ? raw.slice(item.matchedLength).replace(/^'+/, '') : '';
    write((item?.word ?? raw) + (suffix !== undefined ? remaining + suffix : ''));
    updateComposition(suffix !== undefined ? '' : remaining);
  };
  const editKey = async (key: EditKey) => {
    const el = field.current;
    if (!el?.isConnected || el.disabled || el.readOnly) return;
    el.focus({ preventScroll: true });
    if (view.surfaceDesktop?.editKey) {
      try {
        if (
          await view.surfaceDesktop.editKey(
            key,
            selecting && !['Backspace', 'Delete'].includes(key),
          )
        )
          return;
      } catch {}
    }
    if (key === 'Backspace') {
      write('', true);
      return;
    }
    if (key === 'Delete') {
      const start = el.selectionStart ?? 0,
        end = el.selectionEnd ?? start;
      if (start === end)
        selection(el, start, start + (Array.from(el.value.slice(start))[0]?.length ?? 0));
      write('');
      return;
    }
    const next = moveTextSelection(
      el.value,
      el.selectionStart ?? 0,
      el.selectionEnd ?? 0,
      el.selectionDirection ?? 'none',
      key,
      selecting,
    );
    try {
      el.setSelectionRange(next.start, next.end, next.direction);
    } catch {}
  };
  const clipboardHistory = async () => {
    field.current?.focus({ preventScroll: true });
    try {
      if (await view.surfaceDesktop?.openClipboardHistory?.()) {
        setShortcutError('');
        return;
      }
    } catch {}
    setShortcutError(tr('剪贴板历史仅在 Windows 桌面版可用；请确认系统已启用 Win+V。'));
  };
  acceptRef.current = accept;
  const control = (active: boolean) => {
    controlled.current = active;
    host.current?.querySelectorAll<HTMLElement>('[data-skbtn="{ctrl}"]').forEach((button) => {
      button.classList.toggle('keyboard-modifier-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  const insert = (key: string) => {
    if (key === '{shift}') {
      shifted.current = !shifted.current;
      keyboard.current?.setOptions({ layoutName: shifted.current ? 'shift' : 'default' });
      return;
    }
    if (key === '{ctrl}') {
      control(!controlled.current);
      return;
    }
    if (key === '{esc}') {
      control(false);
      if (input.current) updateComposition('');
      else setOpen(false);
      return;
    }
    if (controlled.current && key !== '{shift}') {
      control(false);
      const action = shortcuts.find(([, letter]) => letter.toLowerCase() === key.toLowerCase());
      if (action)
        void shortcut(
          shifted.current && key.toLowerCase() === 'z' ? 'redo' : action[0],
          key.toLowerCase(),
        );
      return;
    }
    if (key === '{tab}') {
      if (input.current) accept();
      const scope =
        hostDocument.activeElement?.closest('[role="dialog"],[aria-modal="true"]') ?? hostDocument;
      const fields = Array.from(
        scope.querySelectorAll<HTMLElement>('input,textarea,[contenteditable="true"]'),
      ).filter(
        (el) =>
          !el.closest('.touch-keyboard') &&
          el.getClientRects().length &&
          (editable(el) ? !el.disabled && !el.readOnly : el.isContentEditable),
      );
      const at = fields.indexOf(hostDocument.activeElement as HTMLElement);
      fields[(at + (shifted.current ? -1 : 1) + fields.length) % fields.length]?.focus({
        preventScroll: true,
      });
      return;
    }
    const el = field.current;
    if (!el?.isConnected || el.disabled || el.readOnly) return;
    if (mode === 'pinyin' && el.type !== 'password') {
      if (/^[a-z']$/.test(key)) {
        if (input.current.length < 48 && (key !== "'" || input.current.length > 0))
          updateComposition(input.current + key);
        return;
      }
      if (input.current) {
        if (key === '{bksp}') {
          updateComposition(input.current.slice(0, -1));
          return;
        }
        if (key === '{enter}') {
          accept();
          return;
        }
        if (/^[1-5]$/.test(key)) {
          const item = candidates[candidatePage * 5 + Number(key) - 1];
          if (item) accept(item);
          return;
        }
        if (key === '{left}' || key === '{right}') {
          setCandidatePage((p) =>
            Math.max(
              0,
              Math.min(Math.ceil(candidates.length / 5) - 1, p + (key === '{left}' ? -1 : 1)),
            ),
          );
          return;
        }
        const suffix =
          key === '{space}'
            ? undefined
            : ((
                { ',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；' } as Record<
                  string,
                  string
                >
              )[key] ?? key);
        // Fast Space taps wait for the latest lookup, never a stale candidate.
        if (!resolved.current && imeStatus !== 'error') {
          deferred.current = suffix ?? '';
          return;
        }
        accept(candidates[candidatePage * 5], suffix);
        return;
      }
    }
    if (key === '{left}' || key === '{right}') {
      const next = Math.max(
        0,
        Math.min(
          el.value.length,
          key === '{left}'
            ? (el.selectionStart ?? el.value.length) - 1
            : (el.selectionEnd ?? el.value.length) + 1,
        ),
      );
      el.focus({ preventScroll: true });
      selection(el, next);
      return;
    }
    if (key === '{enter}' && el.tagName === 'INPUT') return;
    const punctuation =
      mode === 'pinyin' && el.type !== 'password'
        ? (
            { ',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；' } as Record<
              string,
              string
            >
          )[key]
        : undefined;
    write(
      key === '{space}'
        ? ' '
        : key === '{enter}'
          ? '\n'
          : key === '{bksp}'
            ? ''
            : (punctuation ?? key),
      key === '{bksp}',
    );
  };
  insertRef.current = insert;
  useEffect(() => {
    if (!open || mode !== 'pinyin') return;
    ready.current = false;
    setImeStatus('loading');
    const instance = new Worker(new URL('./pinyin.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    instance.onmessage = (event) => {
      const data = event.data;
      if (data.ready) {
        ready.current = true;
        setImeStatus('ready');
        instance.postMessage({ id: request.current, input: input.current });
        return;
      }
      if (data.id !== request.current || data.input !== input.current) return;
      resolved.current = true;
      setCandidates(data.candidates);
      setCandidatePage(0);
      if (deferred.current !== null) {
        const suffix = deferred.current;
        deferred.current = null;
        acceptRef.current(data.candidates[0], suffix || undefined);
      }
    };
    instance.onerror = () => {
      setImeStatus('error');
      ready.current = false;
      if (deferred.current !== null) {
        const suffix = deferred.current;
        deferred.current = null;
        acceptRef.current(undefined, suffix || undefined);
      }
    };
    return () => {
      instance.terminate();
      worker.current = null;
      ready.current = false;
      updateComposition('');
    };
  }, [open, mode]);
  useEffect(() => {
    if (!open || mode === 'voice' || !host.current) return;
    const keys = document.createElement('div');
    keys.className = 'surfacetab-keys';
    host.current.append(keys);
    keyboard.current = new Keyboard(keys, {
      layout,
      // Carets are owned by the editor. The library otherwise collapses native
      // text selections after every key, including Ctrl, before Copy can run.
      disableCaretPositioning: true,
      display: {
        '{bksp}': '⌫',
        '{shift}': '⇧',
        '{enter}': '↵',
        '{space}': tr('空格'),
        '{left}': '←',
        '{right}': '→',
        '{ctrl}': 'Ctrl',
        '{tab}': 'Tab',
        '{esc}': 'Esc',
      },
      onKeyPress: (key) => insertRef.current(key),
      onRender: () => {
        const from = layout.default.flatMap((row) => row.split(' ')),
          to = layout.shift.flatMap((row) => row.split(' '));
        host.current?.querySelectorAll<HTMLElement>('.hg-button').forEach((button, index) => {
          const key = button.dataset.skbtn;
          if (key === '{ctrl}') {
            button.setAttribute('aria-pressed', String(controlled.current));
            button.classList.toggle('keyboard-modifier-active', controlled.current);
          }
          const action = shortcuts.find(
            ([, letter]) => letter.toLowerCase() === key?.toLowerCase(),
          );
          if (action) button.title = `${tr(action[2])} (Ctrl+${action[1]})`;
          if (
            !shifted.current &&
            from[index] &&
            !from[index].startsWith('{') &&
            to[index] !== from[index]
          )
            button.dataset.shiftPreview = to[index];
          else delete button.dataset.shiftPreview;
        });
      },
      preventMouseDownDefault: true,
      preventMouseUpDefault: true,
      stopMouseDownPropagation: true,
      stopMouseUpPropagation: true,
      useButtonTag: true,
    });
    return () => {
      keyboard.current?.destroy();
      keys.remove();
      keyboard.current = null;
      shifted.current = false;
      controlled.current = false;
    };
  }, [open, mode, locale]);
  useEffect(() => {
    const resize = () =>
      setPosition((p) => ({
        x: Math.max(4, Math.min(p.x, view.innerWidth - Math.min(width, view.innerWidth - 8) - 4)),
        y: Math.max(4, Math.min(p.y, view.innerHeight - (panel.current?.offsetHeight ?? 290) - 4)),
      }));
    resize();
    const observer = new ResizeObserver(resize);
    if (panel.current) observer.observe(panel.current);
    view.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      view.removeEventListener('resize', resize);
    };
  }, [width, open, hostDocument]);
  const close = () => {
    if (input.current) accept();
    setVoiceStatus('');
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const physicalInput = (event: KeyboardEvent) => {
      if (
        !event.isTrusted ||
        ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'].includes(event.key)
      )
        return;
      setVoiceStatus('');
      setOpen(false);
    };
    view.addEventListener('keydown', physicalInput, true);
    return () => view.removeEventListener('keydown', physicalInput, true);
  }, [open, view]);
  const toggle = (
    <button
      className={`keyboard-toggle${dock ? ' keyboard-docked' : ''}`}
      style={dock ? undefined : { right }}
      aria-label={open ? tr('收起屏幕键盘') : tr('屏幕键盘')}
      title={tr('屏幕键盘')}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        setSettings(false);
        if (open) close();
        else setOpen(true);
      }}
    >
      <KeyboardIcon size={18} />
    </button>
  );
  return (
    <>
      <FieldEditMenu
        hostDocument={hostDocument}
        onCommand={(command) => shortcut(command, shortcuts.find((s) => s[0] === command)![1])}
      />
      {dock ? createPortal(toggle, dock) : toggle}
      {open && (
        <section
          ref={panel}
          className="touch-keyboard"
          role="dialog"
          aria-label={tr('悬浮屏幕键盘')}
          style={{
            left: position.x,
            top: position.y,
            width: Math.min(width, mode === 'voice' ? 440 : 900, view.innerWidth - 8),
          }}
          onPointerDownCapture={(e) => {
            if (!(e.target as HTMLElement).closest('input,select')) e.preventDefault();
          }}
        >
          <header
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button,input,label')) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = {
                id: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                left: position.x,
                top: position.y,
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d?.id === e.pointerId)
                setPosition({
                  x: Math.max(
                    4,
                    Math.min(
                      view.innerWidth - Math.min(width, view.innerWidth - 8) - 4,
                      d.left + e.clientX - d.x,
                    ),
                  ),
                  y: Math.max(
                    4,
                    Math.min(
                      view.innerHeight - (panel.current?.offsetHeight ?? 290) - 4,
                      d.top + e.clientY - d.y,
                    ),
                  ),
                });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <GripHorizontal size={16} />
            <span>{tr('键盘')}</span>
            <button
              className="keyboard-settings-toggle"
              aria-label={tr('键盘设置')}
              aria-expanded={settings}
              aria-controls="keyboard-settings"
              onClick={() => setSettings((v) => !v)}
            >
              <Settings2 size={15} />
            </button>
            <button aria-label={tr('关闭屏幕键盘')} onClick={close}>
              <X size={15} />
            </button>
          </header>
          <div className="keyboard-modes" role="group" aria-label={tr('键盘输入模式')}>
            {(['latex', 'en', 'pinyin', 'voice'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={mode === value}
                onClick={() => {
                  if (input.current) accept();
                  setMode(value);
                  setVoiceStatus('');
                  localStorage.setItem('surfacetab.keyboardMode', value);
                }}
              >
                {value === 'latex'
                  ? 'LaTeX'
                  : value === 'en'
                    ? tr('英文')
                    : value === 'pinyin'
                      ? tr('中文拼音')
                      : tr('语音')}
              </button>
            ))}
          </div>
          {shortcutError && (
            <p className="keyboard-shortcut-error" role="status">
              {shortcutError}
            </p>
          )}
          {settings && (
            <div id="keyboard-settings" className="keyboard-settings">
              <label>
                {tr('大小')}
                <input
                  aria-label={tr('键盘大小')}
                  type="range"
                  min="320"
                  max="900"
                  value={width}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setWidth(next);
                    localStorage.setItem('surfacetab.keyboardWidth', String(next));
                  }}
                />
              </label>
              <label className="native-keyboard">
                <input
                  type="checkbox"
                  checked={native}
                  onChange={(e) => setNativeKeyboard(e.target.checked)}
                />
                {tr('使用系统触摸键盘')}
              </label>
            </div>
          )}
          {mode === 'latex' && (
            <div className="latex-shortcuts">
              {['\\frac{}{}', '\\sqrt{}', '\\alpha', '\\beta', '\\sum', '\\int', '\\mathbb{}'].map(
                (key) => (
                  <button key={key} onClick={() => insert(key)}>
                    {key}
                  </button>
                ),
              )}
            </div>
          )}
          {mode === 'pinyin' && (
            <div className="keyboard-ime">
              <div className="keyboard-composition">
                <span aria-label={tr('待转换拼音')}>
                  {composition ||
                    tr(
                      imeStatus === 'loading'
                        ? '正在加载本地词库…'
                        : imeStatus === 'error'
                          ? '词库加载失败，可直接输入拼音'
                          : '输入拼音，空格选择首个候选',
                    )}
                </span>
                {composition && (
                  <button aria-label={tr('清空拼音')} onClick={() => updateComposition('')}>
                    <X size={13} />
                  </button>
                )}
              </div>
              <div className="keyboard-candidates" aria-label={tr('拼音候选词')}>
                <button
                  aria-label={tr('上一组候选')}
                  disabled={candidatePage === 0}
                  onClick={() => setCandidatePage((p) => p - 1)}
                >
                  <ChevronLeft size={15} />
                </button>
                <div>
                  {candidates.slice(candidatePage * 5, candidatePage * 5 + 5).map((item, i) => (
                    <button key={`${item.word}:${i}`} onClick={() => accept(item)}>
                      <small>{i + 1}</small>
                      {item.word}
                    </button>
                  ))}
                </div>
                <button
                  aria-label={tr('下一组候选')}
                  disabled={(candidatePage + 1) * 5 >= candidates.length}
                  onClick={() => setCandidatePage((p) => p + 1)}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
          {mode === 'voice' ? (
            <div className="keyboard-voice">
              {!fieldReady && <p>{tr('请先点击需要输入的文本框。')}</p>}
              <DictationButton
                disabled={!fieldReady}
                hostDocument={hostDocument}
                onModels={onModels}
                onStatus={setVoiceStatus}
                onText={(text) => {
                  const el = field.current;
                  const start = el?.selectionStart ?? el?.value.length ?? 0;
                  const end = el?.selectionEnd ?? start;
                  const space =
                    start === end &&
                    /[\w.!?]$/.test(el?.value.slice(0, start) ?? '') &&
                    /^\w/.test(text);
                  write((space ? ' ' : '') + text);
                }}
              />
              {voiceStatus && <p role="status">{voiceStatus}</p>}
              <div className="voice-edit-pad" role="group" aria-label={tr('语音文本编辑')}>
                <div className="voice-edit-navigation">
                  <button
                    disabled={!fieldReady}
                    className="voice-up"
                    aria-label={tr('向上移动光标')}
                    onClick={() => void editKey('ArrowUp')}
                  >
                    <ArrowUp size={20} />
                  </button>
                  <button
                    disabled={!fieldReady}
                    className="voice-left"
                    aria-label={tr('向左移动光标')}
                    onClick={() => void editKey('ArrowLeft')}
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <button
                    disabled={!fieldReady}
                    className="voice-select"
                    aria-pressed={selecting}
                    onClick={() => setSelecting((v) => !v)}
                  >
                    {tr(selecting ? '结束选择' : '开始选择')}
                  </button>
                  <button
                    disabled={!fieldReady}
                    className="voice-right"
                    aria-label={tr('向右移动光标')}
                    onClick={() => void editKey('ArrowRight')}
                  >
                    <ArrowRight size={20} />
                  </button>
                  <button
                    disabled={!fieldReady}
                    className="voice-down"
                    aria-label={tr('向下移动光标')}
                    onClick={() => void editKey('ArrowDown')}
                  >
                    <ArrowDown size={20} />
                  </button>
                  <div className="voice-edit-bottom">
                    <button disabled={!fieldReady} onClick={() => void editKey('Home')}>
                      {tr('行首')}
                    </button>
                    <button disabled={!fieldReady} onClick={() => void shortcut('selectAll', 'A')}>
                      {tr('全选')}
                    </button>
                    <button disabled={!fieldReady} onClick={() => void editKey('End')}>
                      {tr('行尾')}
                    </button>
                  </div>
                </div>
                <div className="voice-edit-commands">
                  <button
                    disabled={!fieldReady}
                    aria-label={tr('退格')}
                    title={tr('退格')}
                    onClick={() => void editKey('Backspace')}
                  >
                    <Delete size={19} />
                  </button>
                  <button disabled={!fieldReady} onClick={() => void editKey('Delete')}>
                    {tr('删除')}
                  </button>
                  {shortcuts.slice(1, 4).map(([command, key, label]) => (
                    <button
                      disabled={!fieldReady}
                      key={command}
                      onClick={() => void shortcut(command, key)}
                    >
                      {tr(label)}
                    </button>
                  ))}
                  <button
                    disabled={!fieldReady}
                    aria-label={tr('剪贴板历史（Win+V）')}
                    title={tr('剪贴板历史（Win+V）')}
                    onClick={() => void clipboardHistory()}
                  >
                    <ClipboardList size={17} /> Win+V
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className={`surfacetab-keys-host keyboard-layout-${mode}`} ref={host} />
          )}
        </section>
      )}
    </>
  );
}
