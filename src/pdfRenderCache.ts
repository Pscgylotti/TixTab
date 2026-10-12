import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { renderPolicy, subscribeAppearance } from './appearance';
import { applyPdfNight } from './pdfNight';

interface State {
  cache: Map<string, HTMLCanvasElement>;
  bytes: number;
  jobs: Map<string, Job>;
  renders: number;
  hits: number;
}
export interface PdfPixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Job {
  state: State;
  key: string;
  pdf: PDFDocumentProxy;
  sourceIndex: number;
  scale: number;
  night: boolean;
  region?: PdfPixelRegion;
  priority: number;
  users: number;
  started: boolean;
  cancelled: boolean;
  abort: AbortController;
  task?: RenderTask;
  promise: Promise<HTMLCanvasElement>;
  resolve: (canvas: HTMLCanvasElement) => void;
  reject: (error: unknown) => void;
}
const states = new WeakMap<PDFDocumentProxy, State>(),
  queue: Job[] = [];
const continuations = new Map<Job, () => void>();
let running = 0;
let interacting = false,
  nativeHidden = false,
  idleTimer: ReturnType<typeof setTimeout> | undefined;
let schedulerInitialized = false;
export function initializeRenderScheduler() {
  if (schedulerInitialized || typeof document.addEventListener !== 'function') return;
  schedulerInitialized = true;
  const down = new Set<number>();
  let visibilityRevision = 0;
  let stalePointerTimer: ReturnType<typeof setTimeout> | undefined;
  const resume = () => {
    interacting = false;
    for (const [job, next] of continuations) {
      if ((!nativeHidden && !document.hidden) || job.cancelled) {
        continuations.delete(job);
        next();
      }
    }
    pump();
  };
  const nativeVisibility = (visible: boolean) => {
    visibilityRevision++;
    nativeHidden = !visible;
    document.documentElement.dataset.windowHidden = String(nativeHidden);
    down.clear();
    clearTimeout(idleTimer);
    if (visible) resume();
  };
  void window.surfaceDesktop
    ?.getWindowVisible?.()
    .then((visible) => {
      // The asynchronous initial snapshot may arrive after a newer restore event.
      if (!visibilityRevision) nativeVisibility(visible);
    })
    .catch(() => {});
  window.surfaceDesktop?.onWindowVisibility?.(nativeVisibility);
  const activity = () => {
    interacting = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!down.size) resume();
    }, renderPolicy().settleMs);
  };
  const pointerActivity = () => {
    activity();
    clearTimeout(stalePointerTimer);
    // Windows may consume pointerup during native menus, dragging or pen loss.
    // A stationary contact must never freeze every PDF render indefinitely.
    stalePointerTimer = setTimeout(() => {
      down.clear();
      resume();
    }, 1500);
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      down.add(e.pointerId);
      pointerActivity();
    },
    { passive: true, capture: true },
  );
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!down.size) return; // Hovering over controls must not postpone rendering.
      if (!e.buttons && e.pointerType !== 'touch') {
        down.clear();
        clearTimeout(stalePointerTimer);
        activity();
      } else if (down.has(e.pointerId)) pointerActivity();
    },
    { passive: true, capture: true },
  );
  const up = (e: PointerEvent) => {
    down.delete(e.pointerId);
    if (!down.size) clearTimeout(stalePointerTimer);
    activity();
  };
  document.addEventListener('pointerup', up, { passive: true, capture: true });
  document.addEventListener('pointercancel', up, { passive: true, capture: true });
  document.addEventListener('lostpointercapture', up, { passive: true, capture: true });
  window.addEventListener('blur', () => {
    down.clear();
    resume();
  });
  document.addEventListener('wheel', activity, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      down.clear();
      resume();
    }
  });
  subscribeAppearance(() => {
    if (!interacting) resume();
  });
}
function paused() {
  return nativeHidden || !!document.hidden || interacting;
}
function stateFor(pdf: PDFDocumentProxy) {
  let state = states.get(pdf);
  if (!state) {
    state = { cache: new Map(), bytes: 0, jobs: new Map(), renders: 0, hits: 0 };
    states.set(pdf, state);
  }
  return state;
}
function cancelled() {
  return new DOMException('页面绘制已取消', 'AbortError');
}
/** A failed PDF worker must not occupy all shared render slots indefinitely. */
function boundedStage<T>(promise: Promise<T>, job: Job): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      job.abort.signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(cancelled());
    };
    job.abort.signal.addEventListener('abort', abort, { once: true });
    const check = () => {
      // Minimized windows intentionally suspend rendering, without burning CPU.
      if (paused() && !job.cancelled) {
        timer = setTimeout(check, 45_000);
        return;
      }
      job.cancelled = true;
      continuations.delete(job);
      job.task?.cancel();
      cleanup();
      reject(new Error('PDF 渲染超时，请重新打开文档。'));
    };
    timer = setTimeout(check, 45_000);
    promise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
function cache(state: State, key: string, canvas: HTMLCanvasElement) {
  state.cache.set(key, canvas);
  state.bytes += canvas.width * canvas.height * 4;
  while (state.bytes > renderPolicy().cacheBytes && state.cache.size > 1) {
    const key = state.cache.keys().next().value!,
      old = state.cache.get(key)!;
    state.bytes -= old.width * old.height * 4;
    state.cache.delete(key);
  }
}
function pump() {
  if (paused()) return;
  queue.sort((a, b) => a.priority - b.priority);
  while (running < renderPolicy().concurrency && queue.length) {
    const job = queue.shift()!;
    if (job.cancelled) continue;
    running++;
    job.started = true;
    void (async () => {
      try {
        const page = await boundedStage(job.pdf.getPage(job.sourceIndex + 1), job);
        if (job.cancelled) throw cancelled();
        const viewport = page.getViewport({ scale: job.scale }),
          canvas = document.createElement('canvas');
        canvas.width = job.region?.width ?? Math.ceil(viewport.width);
        canvas.height = job.region?.height ?? Math.ceil(viewport.height);
        // PDF.js otherwise requests alpha:false, enabling Windows LCD subpixel
        // text AA. Its RGB coverage is tied to light paper and becomes colored
        // fringes after night conversion. Alpha surfaces use grayscale AA;
        // share that source across day/night, thumbnails and tiles without rerendering.
        const canvasContext = canvas.getContext('2d', { alpha: true })!;
        const original = job.night && job.state.cache.get(job.key.replace(':night', ':day'));
        if (original) canvasContext.drawImage(original, 0, 0);
        else {
          job.task = page.render({
            canvas,
            canvasContext,
            viewport,
            ...(job.region ? { transform: [1, 0, 0, 1, -job.region.x, -job.region.y] } : {}),
          });
          job.state.renders++;
          job.task.onContinue = (next: () => void) => {
            if (paused()) continuations.set(job, next);
            else next();
          };
          await boundedStage(job.task.promise, job);
        }
        if (job.cancelled) throw cancelled();
        if (job.night) {
          const transform = [...viewport.transform];
          transform[4] -= job.region?.x ?? 0;
          transform[5] -= job.region?.y ?? 0;
          await boundedStage(applyPdfNight(canvas, job.pdf, job.sourceIndex, transform), job);
        }
        if (job.cancelled) throw cancelled();
        cache(job.state, job.key, canvas);
        job.resolve(canvas);
      } catch (e) {
        job.reject(e);
      } finally {
        continuations.delete(job);
        if (job.state.jobs.get(job.key) === job) job.state.jobs.delete(job.key);
        running--;
        pump();
      }
    })();
  }
}
/** Shared PDF backgrounds. Annotation edits do not invalidate these bitmaps.
 * 0 = current page; 1 = reading pages; 2 = sidebar thumbnails. */
export function requestPdfBitmap(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  scale: number,
  priority = 1,
  night = false,
) {
  return requestBitmap(pdf, sourceIndex, scale, priority, undefined, night);
}
/** Tile coordinates are integer pixels of the rotated/cropped PDF viewport. */
export function requestPdfTile(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  scale: number,
  region: PdfPixelRegion,
  priority = 1,
  night = false,
) {
  if (
    ![region.x, region.y, region.width, region.height].every(Number.isInteger) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.width * region.height > 1_048_576
  )
    throw new RangeError('无效的 PDF 瓦片范围');
  return requestBitmap(pdf, sourceIndex, scale, priority, region, night);
}
function requestBitmap(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  scale: number,
  priority: number,
  region?: PdfPixelRegion,
  night = false,
) {
  initializeRenderScheduler();
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('无效的 PDF 渲染倍率');
  const state = stateFor(pdf),
    key = `${sourceIndex}:${scale.toFixed(3)}:${night ? 'night' : 'day'}${region ? `:tile:${region.x},${region.y},${region.width},${region.height}` : ''}`;
  const existing = state.cache.get(key);
  if (existing) {
    state.hits++;
    state.cache.delete(key);
    state.cache.set(key, existing);
    return { promise: Promise.resolve(existing), cancel: () => {} };
  }
  let job = state.jobs.get(key);
  if (!job || job.cancelled) {
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const promise = new Promise<HTMLCanvasElement>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    job = {
      state,
      key,
      pdf,
      sourceIndex,
      scale: Number(scale.toFixed(3)),
      night,
      region: region && { ...region },
      priority,
      users: 0,
      started: false,
      cancelled: false,
      abort: new AbortController(),
      promise,
      resolve,
      reject,
    };
    state.jobs.set(key, job);
    queue.push(job);
  }
  job.priority = Math.min(priority, job.priority);
  job.users++;
  pump();
  const leased = job;
  let released = false;
  return {
    promise: leased.promise,
    cancel: () => {
      if (released) return;
      released = true;
      leased.users--;
      if (leased.users || state.jobs.get(key) !== leased) return;
      leased.cancelled = true;
      leased.abort.abort();
      state.jobs.delete(key);
      if (leased.started) leased.task?.cancel();
      else {
        const position = queue.indexOf(leased);
        if (position >= 0) queue.splice(position, 1);
        leased.reject(cancelled());
      }
    },
  };
}
export function priorPdfBitmap(pdf: PDFDocumentProxy, sourceIndex: number, night = false) {
  const prefix = `${sourceIndex}:`,
    entries = [...stateFor(pdf).cache];
  return entries
    .reverse()
    .find(
      ([key]) =>
        key.startsWith(prefix) &&
        key.includes(night ? ':night' : ':day') &&
        !key.includes(':tile:'),
    )?.[1];
}
export function getPdfRenderStats(pdf: PDFDocumentProxy) {
  const s = stateFor(pdf);
  return {
    bytes: s.bytes,
    bitmaps: s.cache.size,
    renders: s.renders,
    hits: s.hits,
    running: [...s.jobs.values()].filter((j) => j.started).length,
    queued: [...s.jobs.values()].filter((j) => !j.started).length,
  };
}
export function renderingCancelled(error: unknown) {
  return (
    error instanceof Error && ['AbortError', 'RenderingCancelledException'].includes(error.name)
  );
}
