import type { PDFDocumentProxy, PDFPageProxy } from './pdfTypes';
import { renderPolicy, subscribeAppearance } from './appearance';
import { releasePdfium, type PdfRasterTask } from './pdfiumRaster';
import { applyPdfNight } from './pdfNight';
import {
  performanceDelay,
  performanceLedger,
  performanceOutcome,
  trackPerformance,
  type PerformanceFinish,
} from './performanceLedger';

interface State {
  thumbnail?: boolean;
  cache: Map<string, HTMLCanvasElement>;
  bytes: number;
  pageKeys: Map<number, string>;
  pageBytes: number;
  generation: number;
  viewKey?: string;
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
  task?: PdfRasterTask;
  promise: Promise<HTMLCanvasElement>;
  resolve: (canvas: HTMLCanvasElement) => void;
  reject: (error: unknown) => void;
  finish?: PerformanceFinish;
  generation: number;
}
function bitmapKey(sourceIndex: number, scale: number, night: boolean, region?: PdfPixelRegion) {
  return `${sourceIndex}:${scale.toFixed(3)}:${night ? 'night' : 'day'}${region ? `:tile:${region.x},${region.y},${region.width},${region.height}` : ''}`;
}
export function pageHalves(width: number, height: number) {
  const top = Math.floor(height / 2);
  return [
    { x: 0, y: 0, width, height: top },
    { x: 0, y: top, width, height: height - top },
  ] as const;
}
const states = new WeakMap<PDFDocumentProxy, State>(),
  thumbnailStates = new WeakMap<PDFDocumentProxy, State>(),
  thumbnailLru = new Map<HTMLCanvasElement, { state: State; key: string }>(),
  queue: Job[] = [];
const cachedLocations = new WeakMap<HTMLCanvasElement, { state: State; key: string }>();
const liveCacheStates = new Set<State>();
const retiredBitmaps = new WeakSet<HTMLCanvasElement>();
export const isRetiredPdfBitmap = (canvas: HTMLCanvasElement) => retiredBitmaps.has(canvas);

/** Document switching must release rasters without waiting for React
 * alternate effects or the GC to drop their last proxy reference. */
export function releasePdfRenderCache(pdf: PDFDocumentProxy) {
  releasePdfium(pdf);
  for (const state of [states.get(pdf), thumbnailStates.get(pdf)]) {
    if (!state) continue;
    liveCacheStates.delete(state);
    clearState(state);
  }
}
function clearState(state: State) {
  state.generation++;
  for (const job of [...state.jobs.values()]) {
    job.cancelled = true;
    job.abort.abort();
    if (job.started) job.task?.cancel();
    else {
      const at = queue.indexOf(job);
      if (at >= 0) queue.splice(at, 1);
      job.reject(cancelled());
      job.finish?.('cancelled');
      state.jobs.delete(job.key);
    }
  }
  for (const canvas of [...state.cache.values()]) {
    invalidatePdfBitmap(canvas);
    // A borrowed visible raster is cleared by its display after unmount.
    if (!canvas.isConnected) canvas.width = canvas.height = 1;
  }
}

/** A lost display surface must never remain a successful cached raster. */
export function invalidatePdfBitmap(canvas: HTMLCanvasElement) {
  const entry = cachedLocations.get(canvas);
  if (!entry) return;
  if (entry.state.cache.get(entry.key) === canvas) {
    entry.state.cache.delete(entry.key);
    entry.state.bytes -= canvas.width * canvas.height * 4;
    const page = Number(entry.key.split(':')[0]);
    if (entry.state.pageKeys.get(page) === entry.key) {
      entry.state.pageKeys.delete(page);
      entry.state.pageBytes -= canvas.width * canvas.height * 4;
    }
  }
  cachedLocations.delete(canvas);
  retiredBitmaps.add(canvas);
  thumbnailLru.delete(canvas);
  canvas.removeEventListener('contextlost', cachedContextLost);
}
function cachedContextLost(event: Event) {
  invalidatePdfBitmap(event.currentTarget as HTMLCanvasElement);
}
const continuations = new Map<Job, () => void>();
let running = 0;
let interacting = false,
  nativeHidden = false,
  idleTimer: (() => void) | undefined;
let schedulerInitialized = false;
export function initializeRenderScheduler() {
  if (schedulerInitialized || typeof document.addEventListener !== 'function') return;
  schedulerInitialized = true;
  const down = new Set<number>();
  let visibilityRevision = 0;
  let stalePointerTimer: (() => void) | undefined;
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
    idleTimer?.();
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
    idleTimer?.();
    idleTimer = performanceDelay(
      'render-resume',
      () => {
        if (!down.size) resume();
      },
      renderPolicy().settleMs,
    );
  };
  const pointerActivity = () => {
    activity();
    stalePointerTimer?.();
    // Windows may consume pointerup during native menus, dragging or pen loss.
    // A stationary contact must never freeze every PDF render indefinitely.
    stalePointerTimer = performanceDelay(
      'pointer-recovery',
      () => {
        down.clear();
        resume();
      },
      1500,
    );
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
        stalePointerTimer?.();
        activity();
      } else if (down.has(e.pointerId)) pointerActivity();
    },
    { passive: true, capture: true },
  );
  const up = (e: PointerEvent) => {
    down.delete(e.pointerId);
    if (!down.size) stalePointerTimer?.();
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
function stateFor(pdf: PDFDocumentProxy, thumbnail = false) {
  const store = thumbnail ? thumbnailStates : states;
  let state = store.get(pdf);
  if (!state) {
    state = {
      cache: new Map(),
      bytes: 0,
      pageKeys: new Map(),
      pageBytes: 0,
      generation: 0,
      jobs: new Map(),
      renders: 0,
      hits: 0,
    };
    state.thumbnail = thumbnail;
    store.set(pdf, state);
  }
  liveCacheStates.add(state);
  return state;
}
subscribeAppearance(() => {
  if (!renderPolicy().minimal) return;
  for (const state of liveCacheStates) {
    for (const canvas of [...state.cache.values()]) {
      invalidatePdfBitmap(canvas);
      if (!canvas.isConnected) canvas.width = canvas.height = 1;
    }
    for (const job of [...state.jobs.values()])
      if (job.priority >= 3) {
        job.cancelled = true;
        job.abort.abort();
        job.task?.cancel();
        if (!job.started) {
          const at = queue.indexOf(job);
          if (at >= 0) queue.splice(at, 1);
          state.jobs.delete(job.key);
          job.reject(cancelled());
          job.finish?.('cancelled');
        }
      }
  }
});
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
  if (renderPolicy().minimal) {
    retiredBitmaps.add(canvas);
    return;
  }
  const page = Number(key.split(':')[0]),
    fullPage = !state.thumbnail && !key.includes(':tile:');
  if (fullPage) {
    const oldKey = state.pageKeys.get(page);
    if (oldKey && state.cache.get(oldKey)) invalidatePdfBitmap(state.cache.get(oldKey)!);
  }
  state.cache.set(key, canvas);
  retiredBitmaps.delete(canvas);
  cachedLocations.set(canvas, { state, key });
  canvas.addEventListener('contextlost', cachedContextLost, { once: true });
  state.bytes += canvas.width * canvas.height * 4;
  if (state.thumbnail) {
    thumbnailLru.set(canvas, { state, key });
    while (thumbnailLru.size > 150) invalidatePdfBitmap(thumbnailLru.keys().next().value!);
    return;
  }
  if (fullPage) {
    state.pageKeys.set(page, key);
    state.pageBytes += canvas.width * canvas.height * 4;
  }
  trimPageCache(state);
  while (state.bytes - state.pageBytes > renderPolicy().cacheBytes) {
    const key = [...state.cache.keys()].find((k) => k.includes(':tile:'));
    if (!key) break;
    const old = state.cache.get(key)!;
    performanceLedger?.count('pdfCacheEvictedBytes', old.width * old.height * 4);
    invalidatePdfBitmap(old);
  }
}
function trimPageCache(state: State) {
  const keys = [...state.pageKeys.values()];
  let extra = keys.slice(0, -15).reduce((sum, key) => {
    const c = state.cache.get(key);
    return sum + (c ? c.width * c.height * 4 : 0);
  }, 0);
  while (state.pageKeys.size > 15 && extra > renderPolicy().extraPageBytes) {
    const key = state.pageKeys.values().next().value!,
      c = state.cache.get(key)!;
    const bytes = c.width * c.height * 4;
    extra -= bytes;
    performanceLedger?.count('pdfCacheEvictedBytes', bytes);
    invalidatePdfBitmap(c);
  }
}
export function setPdfViewCacheKey(pdf: PDFDocumentProxy, key: string) {
  const state = stateFor(pdf);
  if (state.viewKey === key) return;
  state.viewKey = key;
  state.generation++;
  for (const canvas of [...state.cache.values()]) invalidatePdfBitmap(canvas);
}
function pump() {
  if (paused()) return;
  queue.sort((a, b) => a.priority - b.priority);
  while (running < renderPolicy().concurrency && queue.length) {
    if (queue[0].priority >= 3 && running > 0) break;
    const job = queue.shift()!;
    if (job.cancelled) continue;
    running++;
    job.started = true;
    void (async () => {
      const scratch = new Set<HTMLCanvasElement>();
      let loadedPage: PDFPageProxy | undefined;
      let output: HTMLCanvasElement | undefined,
        delivered = false;
      try {
        const page = await boundedStage(
          trackPerformance('pdf-page', () => job.pdf.getPage(job.sourceIndex + 1)),
          job,
        );
        loadedPage = page;
        if (job.cancelled) throw cancelled();
        const viewport = page.getViewport({ scale: job.scale }),
          canvas = document.createElement('canvas');
        output = canvas;
        canvas.width = job.region?.width ?? Math.ceil(viewport.width);
        canvas.height = job.region?.height ?? Math.ceil(viewport.height);
        // Grayscale coverage remains valid for day/night conversion.
        const canvasContext = canvas.getContext('2d', { alpha: true })!;
        const original = job.night && job.state.cache.get(job.key.replace(':night', ':day'));
        const halves = pageHalves(canvas.width, canvas.height),
          warm =
            !job.region && !job.state.thumbnail && !original
              ? halves.map((region) => ({
                  region,
                  canvas: job.state.cache.get(
                    bitmapKey(job.sourceIndex, job.scale, job.night, region),
                  ),
                }))
              : [],
          ready = warm.filter((part) => part.canvas),
          missing = ready.length === 1 ? warm.find((part) => !part.canvas)?.region : undefined,
          targetRegion = job.region ?? missing,
          fullWidth = Math.ceil(viewport.width),
          fullHeight = Math.ceil(viewport.height),
          region = targetRegion,
          work = missing ? document.createElement('canvas') : canvas;
        if (work !== canvas) scratch.add(work);
        if (region && missing) {
          work.width = region.width;
          work.height = region.height;
        }
        const workContext =
          work !== canvas ? work.getContext('2d', { alpha: true })! : canvasContext;
        if (original) workContext.drawImage(original, 0, 0);
        else if (ready.length !== 2) {
          job.task = page.render({
            canvas: work,
            canvasContext: workContext,
            viewport,
            background: '#ffffff',
            ...(region ? { transform: [1, 0, 0, 1, -region.x, -region.y] } : {}),
          });
          job.state.renders++;
          performanceLedger?.count('pdfPixels', work.width * work.height);
          job.task.onContinue = (next: () => void) => {
            if (paused()) continuations.set(job, next);
            else next();
          };
          await boundedStage(
            trackPerformance('pdf-raster', () => job.task!.promise),
            job,
          );
        }
        if (job.cancelled) throw cancelled();
        canvas.dataset.pdfBackend = 'pdfium';
        if (job.night && ready.length !== 2) {
          const transform = [...viewport.transform];
          transform[4] -= region?.x ?? 0;
          transform[5] -= region?.y ?? 0;
          await boundedStage(
            trackPerformance('pdf-night', () =>
              applyPdfNight(work, job.pdf, job.sourceIndex, transform, true),
            ),
            job,
          );
        }
        if (ready.length) {
          for (const part of ready)
            canvasContext.drawImage(part.canvas!, part.region.x, part.region.y);
          if (missing)
            canvasContext.drawImage(
              work,
              0,
              missing.y - region!.y,
              missing.width,
              missing.height,
              missing.x,
              missing.y,
              missing.width,
              missing.height,
            );
        }
        if (job.cancelled) throw cancelled();
        if (job.generation === job.state.generation) cache(job.state, job.key, canvas);
        else retiredBitmaps.add(canvas);
        delivered = true;
        job.resolve(canvas);
        job.finish?.();
      } catch (e) {
        job.reject(e);
        job.finish?.(performanceOutcome(e));
      } finally {
        // RenderTask and its continuation can outlive the job through a display's
        // lease. Release temporary full-page/half-page surfaces deterministically.
        for (const canvas of scratch) canvas.width = canvas.height = 1;
        if (!delivered && output) output.width = output.height = 1;
        job.task = undefined;
        if (renderPolicy().minimal && loadedPage) {
          loadedPage.cleanup?.();
        }
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
export function requestPdfHalf(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  scale: number,
  width: number,
  height: number,
  side: 'top' | 'bottom',
  night = false,
) {
  const rounded = Number(scale.toFixed(3)),
    regions = pageHalves(Math.ceil(width * rounded), Math.ceil(height * rounded)),
    region = regions[side === 'top' ? 0 : 1];
  if (region.height < 1) return requestPdfBitmap(pdf, sourceIndex, scale, 3, night);
  return requestBitmap(pdf, sourceIndex, scale, 3, region, night);
}
export function hasPdfBitmap(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  scale: number,
  night = false,
) {
  return stateFor(pdf).cache.has(bitmapKey(sourceIndex, scale, night));
}
/** A separate, global 150-image LRU prevents large PDF pages from evicting
 * sidebar previews. It retains thumbnail states only, never full-size caches. */
export function requestPdfThumbnail(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  width: number,
  height: number,
  night = false,
) {
  if (![width, height].every((v) => Number.isFinite(v) && v > 0))
    throw new RangeError('无效的缩略图尺寸');
  return requestBitmap(
    pdf,
    sourceIndex,
    Math.min(180 / width, 240 / height),
    2,
    undefined,
    night,
    true,
  );
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
  thumbnail = false,
) {
  initializeRenderScheduler();
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('无效的 PDF 渲染倍率');
  const state = stateFor(pdf, thumbnail),
    key = bitmapKey(sourceIndex, scale, night, region);
  const existing = state.cache.get(key);
  if (existing) {
    state.hits++;
    performanceLedger?.count('pdfCacheHits');
    state.cache.delete(key);
    state.cache.set(key, existing);
    if (state.pageKeys.get(sourceIndex) === key) {
      state.pageKeys.delete(sourceIndex);
      state.pageKeys.set(sourceIndex, key);
      trimPageCache(state);
    }
    const thumbnailEntry = thumbnailLru.get(existing);
    if (thumbnailEntry) {
      thumbnailLru.delete(existing);
      thumbnailLru.set(existing, thumbnailEntry);
    }
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
      finish: performanceLedger?.begin('pdf-job'),
      generation: state.generation,
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
        leased.finish?.('cancelled');
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
  const t = thumbnailStates.get(pdf);
  const jobs = [...s.jobs.values(), ...(t?.jobs.values() ?? [])];
  return {
    bytes: s.bytes + (t?.bytes ?? 0),
    bitmaps: s.cache.size + (t?.cache.size ?? 0),
    thumbnails: t?.cache.size ?? 0,
    pages: s.pageKeys.size,
    pageBytes: s.pageBytes,
    renders: s.renders + (t?.renders ?? 0),
    hits: s.hits + (t?.hits ?? 0),
    running: jobs.filter((j) => j.started).length,
    queued: jobs.filter((j) => !j.started).length,
  };
}
export function renderingCancelled(error: unknown) {
  return (
    error instanceof Error && ['AbortError', 'RenderingCancelledException'].includes(error.name)
  );
}
