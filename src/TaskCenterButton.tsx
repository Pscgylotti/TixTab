import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
const TaskCenter = lazy(() => import('./TaskCenter'));
export default function TaskCenterButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="task-center-trigger" type="button" onClick={() => setOpen(true)}>
        {t('任务与后端')}
      </button>
      {open &&
        createPortal(
          <Suspense fallback={null}>
            <TaskCenter onClose={() => setOpen(false)} />
          </Suspense>,
          document.body,
        )}
    </>
  );
}
