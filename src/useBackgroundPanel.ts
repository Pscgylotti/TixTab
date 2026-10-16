import { useEffect, useRef, useState } from 'react';
import { backgroundTasks } from './backgroundTasks';
import { t } from './i18n';
/** Only metadata and active controls enter the global registry, never document buffers. */
export function useBackgroundPanel(options: {
  title: string;
  busy: boolean;
  status: string;
  done?: number;
  total?: number;
  cancel: () => void;
  onClose: () => void;
  onVisibility?: (hidden: boolean) => void;
}) {
  const [hidden, setHidden] = useState(false);
  const current = useRef(options);
  current.current = options;
  const id = useRef<string | null>(null);
  const hide = () => {
    setHidden(true);
    current.current.onVisibility?.(true);
  };
  const open = () => {
    setHidden(false);
    current.current.onVisibility?.(false);
  };
  useEffect(() => {
    if (options.busy && !id.current)
      id.current = backgroundTasks.begin(options.title, {
        open,
        cancel: () => current.current.cancel(),
      });
    else if (!options.busy && id.current) {
      backgroundTasks.finish(id.current, options.status || t('任务已结束'));
      id.current = null;
      if (hidden) current.current.onClose();
    }
  }, [options.busy]);
  useEffect(() => {
    if (id.current)
      backgroundTasks.update(id.current, {
        status: options.status,
        done: options.done ?? 0,
        total: options.total ?? 0,
        hidden,
      });
  }, [options.busy, options.status, options.done, options.total, hidden]);
  useEffect(
    () => () => {
      if (id.current) backgroundTasks.finish(id.current, t('已取消'));
    },
    [],
  );
  return { hidden, hide, open };
}
