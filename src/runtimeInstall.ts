import { useEffect, useSyncExternalStore } from 'react';
import type { RuntimeId, RuntimeProgress, RuntimeState, RuntimeBridge } from './runtimeBridge';
type Result = { ok: boolean; data?: RuntimeState; error?: string };
type Snapshot = {
  active: RuntimeId | null;
  progress: RuntimeProgress | null;
  result: ({ id: RuntimeId } & Result) | null;
};
let snapshot: Snapshot = { active: null, progress: null, result: null };
const listeners = new Set<() => void>();
let bridge: RuntimeBridge | undefined;
let off: (() => void) | undefined;
let task: { id: RuntimeId; promise: Promise<Result> } | null = null;
const change = (next: Snapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};
function connect() {
  const next = window.surfaceDesktop?.runtimes;
  if (bridge === next) return;
  off?.();
  bridge = next;
  off = next?.onProgress((progress) => {
    if (progress.stage === 'idle') {
      if (snapshot.active === progress.id) {
        change({ ...snapshot, active: null, progress });
        if (task?.id !== progress.id)
          void next
            .run({ id: progress.id, action: 'status' })
            .then((r) =>
              change({ ...snapshot, result: { id: progress.id, ...r, ok: !!r.data?.installed } }),
            )
            .catch(() => {});
      }
    } else change({ ...snapshot, active: progress.id, progress });
  });
}
export function useRuntimeInstall() {
  useEffect(connect, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
export function installRuntime(id: RuntimeId): Promise<Result> {
  connect();
  if (task) return task.id === id ? task.promise : Promise.resolve({ ok: false, error: 'busy' });
  if (snapshot.active) return Promise.resolve({ ok: false, error: 'busy' });
  if (!bridge) return Promise.resolve({ ok: false, error: 'unsupported' });
  change({ active: id, progress: { id, stage: 'check', done: 0, total: 0 }, result: null });
  const current = bridge;
  const promise = current
    .run({ id, action: 'install' })
    .catch(() => ({ ok: false, error: 'setup' }))
    .then((result) => {
      task = null;
      change({ active: null, progress: null, result: { id, ...result } });
      return result;
    });
  task = { id, promise };
  return promise;
}
export function cancelRuntime() {
  const id = snapshot.active || task?.id;
  return id && bridge ? bridge.run({ id, action: 'cancel' }) : Promise.resolve({ ok: false });
}
