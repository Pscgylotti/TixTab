export type BackgroundTask = {
  id: string;
  title: string;
  status: string;
  done: number;
  total: number;
  active: boolean;
  hidden: boolean;
};
let snapshot: BackgroundTask[] = [];
const listeners = new Set<() => void>();
const actions = new Map<string, { open: () => void; cancel: () => void }>();
const emit = () => listeners.forEach((fn) => fn());
export const backgroundTasks = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: () => snapshot,
  begin(title: string, controls: { open: () => void; cancel: () => void }) {
    const id = crypto.randomUUID();
    actions.set(id, controls);
    snapshot = [
      {
        id,
        title: title.slice(0, 100),
        status: '',
        done: 0,
        total: 0,
        active: true,
        hidden: false,
      },
      ...snapshot,
    ];
    emit();
    return id;
  },
  update(id: string, patch: Partial<Pick<BackgroundTask, 'status' | 'done' | 'total' | 'hidden'>>) {
    snapshot = snapshot.map((task) =>
      task.id === id
        ? { ...task, ...patch, status: (patch.status ?? task.status).slice(0, 300) }
        : task,
    );
    emit();
  },
  finish(id: string, status?: string) {
    actions.delete(id);
    snapshot = snapshot.map((task) =>
      task.id === id
        ? { ...task, active: false, status: (status ?? task.status).slice(0, 300) }
        : task,
    );
    let ended = 0;
    snapshot = snapshot.filter((task) => task.active || ++ended <= 20);
    emit();
  },
  open(id: string) {
    actions.get(id)?.open();
  },
  cancel(id: string) {
    actions.get(id)?.cancel();
  },
  clear() {
    snapshot = snapshot.filter((task) => task.active);
    emit();
  },
};
