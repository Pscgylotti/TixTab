import { t as tr, useLocale } from './i18n';
import { useEffect, useState } from 'react';
import { Maximize, Minimize } from 'lucide-react';
export default function FullscreenButton({ className = '' }: { className?: string }) {
  useLocale();
  const [active, setActive] = useState(!!document.fullscreenElement);
  const [error, setError] = useState('');
  const toggle = async () => {
    try {
      setError('');
      if (window.surfaceDesktop) {
        setActive(await window.surfaceDesktop.toggleFullscreen());
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError(tr('\u8BF7\u91CD\u542F\u684C\u9762\u7A97\u53E3\u4EE5\u542F\u7528\u5168\u5C4F'));
    }
  };
  useEffect(() => {
    const changed = () => setActive(!!document.fullscreenElement);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F11' || (e.key === 'Escape' && window.surfaceDesktop && active)) {
        e.preventDefault();
        void toggle();
      }
    };
    const unsubscribe = window.surfaceDesktop?.onFullscreen(setActive);
    document.addEventListener('fullscreenchange', changed);
    window.addEventListener('keydown', key);
    return () => {
      unsubscribe?.();
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('keydown', key);
    };
  }, [active]);
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={active ? tr('退出全屏') : tr('全屏')}
      title={error || (active ? tr('退出全屏 (F11 / Esc)') : tr('全屏 (F11)'))}
      onClick={() => void toggle()}
    >
      {active ? <Minimize size={17} /> : <Maximize size={17} />}
    </button>
  );
}
