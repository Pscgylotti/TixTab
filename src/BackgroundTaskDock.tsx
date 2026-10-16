import { useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  Square,
  ExternalLink,
  ListTodo,
  X,
} from 'lucide-react';
import { backgroundTasks } from './backgroundTasks';
import { providerTasks } from './providerTasks';
import { useRuntimeInstall, cancelRuntime } from './runtimeInstall';
import { runtimeStages } from './RuntimeInstallProgress';
import { t, useLocale } from './i18n';
import './backgroundTasks.css';
const titles = { translation: '翻译', ocr: '文字 OCR', formula: '公式识别', speech: '朗读' };
export default function BackgroundTaskDock() {
  useLocale();
  const tasks = useSyncExternalStore(backgroundTasks.subscribe, backgroundTasks.getSnapshot);
  const providers = useSyncExternalStore(providerTasks.subscribe, providerTasks.getSnapshot);
  const runtime = useRuntimeInstall();
  const [expanded, setExpanded] = useState(true);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const jobs = [
    ...tasks.map((job) => ({
      ...job,
      cancel: () => backgroundTasks.cancel(job.id),
      open: () => backgroundTasks.open(job.id),
    })),
    ...providers
      .filter((job) => !job.endedAt)
      .map((job) => ({
        id: job.id,
        title: t(titles[job.feature]),
        status: t(job.status || (job.phase === 'queued' ? '排队中' : '运行中')),
        active: true,
        hidden: false,
        done: 0,
        total: 0,
        cancel: () => providerTasks.cancel(job.id),
        open: undefined,
      })),
    ...(runtime.active
      ? [
          {
            id: `runtime-${runtime.active}`,
            title: `${runtime.active} · ${t('运行时安装')}`,
            status: t(runtimeStages[runtime.progress?.stage || 'check'] || '处理中'),
            active: true,
            hidden: false,
            done: runtime.progress?.done ?? 0,
            total: runtime.progress?.total ?? 0,
            cancel: () => {
              void cancelRuntime();
            },
            open: undefined,
          },
        ]
      : []),
  ];
  if (!jobs.length) return null;
  const count = jobs.filter((job) => job.active).length;
  return createPortal(
    <aside
      className="background-task-dock"
      aria-label={t('后台任务')}
      style={{ transform: `translate(${position.x}px,${position.y}px)` }}
    >
      <header
        onPointerDown={(e) => {
          if ((e.target as Element).closest('button')) return;
          const r = e.currentTarget.parentElement!.getBoundingClientRect();
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const el = e.currentTarget.parentElement!,
            r = el.getBoundingClientRect();
          const left = Math.max(8, Math.min(innerWidth - r.width - 8, d.left + e.clientX - d.x));
          const top = Math.max(8, Math.min(innerHeight - r.height - 8, d.top + e.clientY - d.y));
          setPosition((p) => ({ x: p.x + left - r.left, y: p.y + top - r.top }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <GripHorizontal size={13} />
        <ListTodo size={15} />
        <strong>
          {t('后台任务')}
          {count ? ` · ${count}` : ''}
        </strong>
        {!count && (
          <button aria-label={t('清除已结束任务')} onClick={backgroundTasks.clear}>
            <X size={14} />
          </button>
        )}
        <button
          aria-label={t(expanded ? '收起后台任务' : '展开后台任务')}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </header>
      {expanded && (
        <div className="background-task-list">
          {jobs.map((job) => (
            <article key={job.id} data-task-id={job.id} data-active={job.active}>
              <div>
                <strong>{job.title}</strong>
                {job.active && job.open && (
                  <button aria-label={t('打开任务 {0}', job.title)} onClick={job.open}>
                    <ExternalLink size={13} />
                  </button>
                )}
                {job.active && (
                  <button aria-label={t('停止任务 {0}', job.title)} onClick={job.cancel}>
                    <Square size={12} />
                  </button>
                )}
              </div>
              <small role="status">{job.status || t(job.active ? '运行中' : '任务已结束')}</small>
              {job.active &&
                (job.total > 0 ? <progress max={job.total} value={job.done} /> : <progress />)}
            </article>
          ))}
        </div>
      )}
    </aside>,
    document.body,
  );
}
