import { useEffect, useRef, useState } from 'react';

/** Keep chat state in the reader while rendering into an owned native window. */
export function useChatWindow() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const child = useRef<Window | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const dock = () => {
    cleanup.current();
    const window = child.current;
    child.current = null;
    setTarget(null);
    window?.close();
  };
  useEffect(
    () => () => {
      cleanup.current();
      child.current?.close();
    },
    [],
  );
  const detach = () => {
    if (child.current && !child.current.closed) {
      child.current.focus();
      return true;
    }
    const window = globalThis.window.open(
      '',
      'surfacetab-chat-floating',
      'popup,width=480,height=780',
    );
    if (!window) return false;
    try {
      const doc = window.document;
      doc.title = 'TixTab · ChatGPT';
      doc.body.className = 'chat-popout-host';
      const base = doc.createElement('base');
      base.href = document.baseURI;
      doc.head.append(base);
      const styles = () => {
        doc.head.querySelectorAll('[data-chat-style]').forEach((node) => node.remove());
        for (const node of document.head.querySelectorAll('style,link[rel="stylesheet"]')) {
          const copy = node.cloneNode(true) as HTMLElement;
          copy.dataset.chatStyle = '';
          doc.head.append(copy);
        }
      };
      const theme = () => {
        for (const name of ['class', 'style', 'lang', 'data-night']) {
          const value = document.documentElement.getAttribute(name);
          if (value === null) doc.documentElement.removeAttribute(name);
          else doc.documentElement.setAttribute(name, value);
        }
      };
      styles();
      theme();
      const themeObserver = new MutationObserver(theme);
      themeObserver.observe(document.documentElement, { attributes: true });
      const styleObserver = new MutationObserver(styles);
      styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
      const closed = () => {
        cleanup.current();
        child.current = null;
        setTarget(null);
      };
      window.addEventListener('beforeunload', closed);
      cleanup.current = () => {
        themeObserver.disconnect();
        styleObserver.disconnect();
        window.removeEventListener('beforeunload', closed);
      };
      child.current = window;
      setTarget(doc.body);
      window.focus();
      return true;
    } catch {
      window.close();
      return false;
    }
  };
  return { target, detach, dock };
}
