import { afterEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
vi.mock('./pdfNight', () => ({ applyPdfNight: () => Promise.resolve() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture(powerMode = 'quality') {
  vi.resetModules();
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    documentElement: { dataset: {} as Record<string, string> },
    createElement: () =>
      Object.assign(new EventTarget(), {
        width: 0,
        height: 0,
        dataset: {},
        getContext: () => ({}),
      }),
  });
  let visibility!: (visible: boolean) => void, initial!: (visible: boolean) => void;
  const snapshot = new Promise<boolean>((resolve) => {
    initial = resolve;
  });
  const window = Object.assign(new EventTarget(), {
    surfaceDesktop: {
      getWindowVisible: () => snapshot,
      onWindowVisibility: (listener: (visible: boolean) => void) => {
        visibility = listener;
      },
    },
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key === 'tixtab.performance.enabled'
        ? 'true'
        : key === 'surfacetab.powerMode'
          ? powerMode
          : null,
  });
  const scheduler = await import('./pdfRenderCache');
  const render = vi.fn<
    () => { promise: Promise<void>; cancel: () => void; onContinue?: (next: () => void) => void }
  >(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(async () => ({
    getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] }),
    render,
  }));
  const pdf = { getPage } as unknown as PDFDocumentProxy;
  scheduler.initializeRenderScheduler();
  function pointer(type: string, id = 1, buttons = 1, pointerType = 'pen') {
    document.dispatchEvent(Object.assign(new Event(type), { pointerId: id, buttons, pointerType }));
  }
  let source = 0;
  return {
    scheduler,
    document,
    window,
    render,
    getPage,
    pointer,
    visibility: (visible: boolean) => visibility(visible),
    initial,
    request: () => scheduler.requestPdfBitmap(pdf, source++, 1),
  };
}
it('queued pixels resume at the same 200 ms boundary after release, independent of pen hover', async () => {
  const f = await fixture();
  f.pointer('pointerdown');
  const lease = f.request();
  await vi.advanceTimersByTimeAsync(100);
  f.pointer('pointermove');
  await vi.advanceTimersByTimeAsync(300);
  expect(f.getPage).not.toHaveBeenCalled();
  f.pointer('pointerup', 1, 0);
  await vi.advanceTimersByTimeAsync(100);
  f.pointer('pointermove', 1, 0);
  await vi.advanceTimersByTimeAsync(99);
  expect(f.getPage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await lease.promise;
  expect(f.render).toHaveBeenCalledOnce();
});
it('eco mode retains its 320 ms quiet period after the final release', async () => {
  const f = await fixture('eco');
  f.pointer('pointerdown');
  const lease = f.request();
  await vi.advanceTimersByTimeAsync(500);
  expect(f.getPage).not.toHaveBeenCalled();
  f.pointer('pointerup', 1, 0);
  await vi.advanceTimersByTimeAsync(319);
  expect(f.getPage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await lease.promise;
  expect(f.render).toHaveBeenCalledOnce();
});
it.each(['pointercancel', 'lostpointercapture'])(
  '%s keeps the release quiet period and cannot strand rendering',
  async (type) => {
    const f = await fixture();
    f.pointer('pointerdown');
    const lease = f.request();
    f.pointer(type, 1, 0);
    await vi.advanceTimersByTimeAsync(199);
    expect(f.getPage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await lease.promise;
    expect(f.getPage).toHaveBeenCalledOnce();
  },
);
it('multiple touch contacts stay paused until the final release', async () => {
  const f = await fixture();
  f.pointer('pointerdown', 1, 1, 'touch');
  f.pointer('pointerdown', 2, 1, 'touch');
  const lease = f.request();
  f.pointer('pointerup', 1, 0, 'touch');
  await vi.advanceTimersByTimeAsync(250);
  expect(f.getPage).not.toHaveBeenCalled();
  f.pointer('pointermove', 2, 0, 'touch');
  f.pointer('pointerup', 2, 0, 'touch');
  await vi.advanceTimersByTimeAsync(199);
  expect(f.getPage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await lease.promise;
  expect(f.render).toHaveBeenCalledOnce();
});
it('lost release recovers exactly 1500 ms after the last confirmed contact movement', async () => {
  const f = await fixture();
  f.pointer('pointerdown');
  const lease = f.request();
  await vi.advanceTimersByTimeAsync(1400);
  f.pointer('pointermove');
  await vi.advanceTimersByTimeAsync(1499);
  expect(f.getPage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await lease.promise;
  expect(f.render).toHaveBeenCalledOnce();
});
it('buttons-zero mouse or pen motion clears a lost contact and resumes after settling', async () => {
  const f = await fixture();
  f.pointer('pointerdown');
  const lease = f.request();
  f.pointer('pointermove', 1, 0);
  await vi.advanceTimersByTimeAsync(199);
  expect(f.getPage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await lease.promise;
});
it('wheel bursts extend the no-contact quiet period without resuming early', async () => {
  const f = await fixture();
  f.document.dispatchEvent(new Event('wheel'));
  const lease = f.request();
  await vi.advanceTimersByTimeAsync(180);
  f.document.dispatchEvent(new Event('wheel'));
  await vi.advanceTimersByTimeAsync(199);
  expect(f.getPage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await lease.promise;
});
it('blur clears stale contact immediately and hidden windows only resume on restore', async () => {
  const f = await fixture();
  f.pointer('pointerdown');
  const a = f.request();
  f.window.dispatchEvent(new Event('blur'));
  await a.promise;
  f.visibility(false);
  const b = f.request();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.getPage).toHaveBeenCalledOnce();
  f.visibility(true);
  await b.promise;
  expect(f.getPage).toHaveBeenCalledTimes(2);
});
it('a delayed initial visibility snapshot cannot override a newer native restore', async () => {
  const f = await fixture();
  f.visibility(false);
  const a = f.request();
  f.visibility(true);
  f.initial(false);
  await a.promise;
  expect(f.document.documentElement.dataset.windowHidden).toBe('false');
});
it('document restore resumes queued work after a hidden contact recovery', async () => {
  const f = await fixture();
  f.document.hidden = true;
  f.pointer('pointerdown');
  const a = f.request();
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.getPage).not.toHaveBeenCalled();
  f.document.hidden = false;
  f.document.dispatchEvent(new Event('visibilitychange'));
  await a.promise;
});
it('cancelled work never starts when input eventually releases the queue', async () => {
  const f = await fixture();
  f.pointer('pointerdown');
  const a = f.request();
  const rejection = expect(a.promise).rejects.toMatchObject({ name: 'AbortError' });
  a.cancel();
  await rejection;
  f.pointer('pointerup', 1, 0);
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.getPage).not.toHaveBeenCalled();
});
it('an in-flight PDF continuation pauses during input and resumes only once', async () => {
  const f = await fixture();
  let finish!: () => void;
  const task: {
    promise: Promise<void>;
    cancel: () => void;
    onContinue?: (next: () => void) => void;
  } = {
    promise: new Promise((r) => {
      finish = r;
    }),
    cancel: vi.fn(),
  };
  f.render.mockReturnValueOnce(task);
  const a = f.request();
  await vi.advanceTimersByTimeAsync(0);
  f.pointer('pointerdown');
  const next = vi.fn(finish);
  task.onContinue!(next);
  await vi.advanceTimersByTimeAsync(300);
  expect(next).not.toHaveBeenCalled();
  f.pointer('pointerup', 1, 0);
  await vi.advanceTimersByTimeAsync(200);
  await a.promise;
  await vi.advanceTimersByTimeAsync(2000);
  expect(next).toHaveBeenCalledOnce();
});
