import { afterEach, test, expect, vi } from 'vitest';
import type { Notebook } from './model';
import { exportPdf, SignedPdfExportError } from './pdfExportClient';
import { packPdfExport, unpackPdfExport } from './pdfExportSnapshot';
import { finalInkPath } from './ink';
const notebook = (): Notebook => ({
  version: 1,
  name: 'export',
  source: new Uint8Array([1, 2, 3]),
  scene: { unused: () => {} },
  pages: [
    {
      id: 'page',
      sourceIndex: 0,
      width: 300,
      height: 500,
      paper: 'plain',
      strokes: [
        {
          id: 'ink',
          tool: 'pen',
          size: 4,
          color: '#ff0000',
          points: [
            [1 / 3, 2 / 7, 0.123456789123],
            [20, 30, 0.9],
          ],
        },
      ],
      images: [
        {
          id: 'image',
          kind: 'formula',
          data: 'data:image/png;base64,AA==',
          displayData: 'large SVG preview',
          scene: { unused: () => {} },
          latex: 'x',
          macros: { '\\x': 'x' },
          x: 1,
          y: 2,
          width: 3,
          height: 4,
        },
      ],
    },
  ],
});
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn((value: any, transfers: Transferable[]) => {
    this.request = structuredClone(value, { transfer: transfers });
  });
  terminate = vi.fn();
  request: any;
  constructor() {
    FakeWorker.instances.push(this);
  }
  reply(data: any) {
    this.onmessage?.({ data });
  }
}
function setup() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', new EventTarget());
}
async function started(index = 0) {
  await vi.waitFor(() => expect(FakeWorker.instances[index]?.postMessage).toHaveBeenCalled());
  return FakeWorker.instances[index];
}
afterEach(() => vi.unstubAllGlobals());

test('transfer snapshot strips project-only payload, keeps exact source view/pressure and leaves the project attached', async () => {
  const n = notebook(),
    backing = new Uint8Array([9, 1, 2, 3, 9]);
  n.source = backing.subarray(1, 4);
  const packed = await packPdfExport(n, new AbortController().signal),
    moved = structuredClone(packed.notebook, { transfer: packed.transfers });
  expect(n.source).toEqual(new Uint8Array([1, 2, 3]));
  expect(backing.byteLength).toBe(5);
  expect(packed.notebook.source?.byteLength).toBe(0);
  const result = unpackPdfExport(moved);
  expect(result.source).toEqual(n.source);
  expect(result.pages[0].strokes).toEqual(n.pages[0].strokes);
  expect(result.scene).toBeUndefined();
  expect(result.pages[0].images[0]).toEqual({
    id: 'image',
    kind: 'formula',
    data: 'data:image/png;base64,AA==',
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
});
test('already-computed pressure outline survives worker transfer without resampling or transferring raw points', async () => {
  const n = notebook(),
    stroke = n.pages[0].strokes[0],
    path = finalInkPath(stroke),
    packed = await packPdfExport(n, new AbortController().signal);
  expect(packed.transfers).toHaveLength(1);
  const result = unpackPdfExport(structuredClone(packed.notebook, { transfer: packed.transfers }));
  expect(finalInkPath(result.pages[0].strokes[0])).toBe(path);
  expect(n.pages[0].strokes[0].points).toHaveLength(2);
});
test('snapshot preparation cooperatively aborts a large copy without detaching original bytes', async () => {
  const n = notebook();
  n.source = new Uint8Array(32 * 1024 * 1024);
  n.source[0] = 123;
  const controller = new AbortController(),
    job = packPdfExport(n, controller.signal);
  queueMicrotask(() => controller.abort());
  await expect(job).rejects.toHaveProperty('name', 'AbortError');
  expect(n.source.byteLength).toBe(32 * 1024 * 1024);
  expect(n.source[0]).toBe(123);
});
test('successful worker progress/result transfers ownership once and terminates the document worker', async () => {
  setup();
  const n = notebook(),
    progress = vi.fn(),
    job = exportPdf(n, { onProgress: progress }),
    w = await started();
  w.reply({ type: 'progress', progress: { stage: 'saving' } });
  const bytes = new Uint8Array([37, 80, 68, 70]);
  w.reply({ type: 'complete', bytes: bytes.buffer });
  const result = await job;
  expect(result.buffer).toBe(bytes.buffer);
  expect(n.source).toEqual(new Uint8Array([1, 2, 3]));
  expect(progress).toHaveBeenLastCalledWith({ stage: 'saving' });
  expect(w.terminate).toHaveBeenCalledTimes(1);
  expect(w.onmessage).toBeNull();
});
test('aborted/preparing requests allocate no worker and leave the export lane free', async () => {
  setup();
  const controller = new AbortController();
  controller.abort();
  await expect(exportPdf(notebook(), { signal: controller.signal })).rejects.toHaveProperty(
    'name',
    'AbortError',
  );
  const preparing = new AbortController();
  await expect(
    exportPdf(notebook(), { signal: preparing.signal, onProgress: () => preparing.abort() }),
  ).rejects.toHaveProperty('name', 'AbortError');
  expect(FakeWorker.instances).toHaveLength(0);
  const retry = exportPdf(notebook()),
    w = await started();
  w.reply({ type: 'complete', bytes: new ArrayBuffer(1) });
  await retry;
});
test('active cancellation suppresses late messages, terminates and permits a fresh retry', async () => {
  setup();
  const controller = new AbortController(),
    progress = vi.fn(),
    job = exportPdf(notebook(), { signal: controller.signal, onProgress: progress }),
    rejected = expect(job).rejects.toHaveProperty('name', 'AbortError'),
    w = await started(),
    late = w.onmessage!;
  controller.abort();
  await rejected;
  late({ data: { type: 'progress', progress: { stage: 'saving' } } });
  late({ data: { type: 'complete', bytes: new ArrayBuffer(1) } });
  expect(progress).toHaveBeenCalledTimes(1);
  expect(w.terminate).toHaveBeenCalledTimes(1);
  const retry = exportPdf(notebook()),
    next = await started(1);
  next.reply({ type: 'complete', bytes: new ArrayBuffer(2) });
  expect((await retry).length).toBe(2);
});
test('one export per window prevents duplicate workers and retains typed signed-document errors', async () => {
  setup();
  const first = exportPdf(notebook()),
    rejected = expect(first).rejects.toBeInstanceOf(SignedPdfExportError),
    w = await started();
  await expect(exportPdf(notebook())).rejects.toThrow('正在导出');
  expect(FakeWorker.instances).toHaveLength(1);
  w.reply({ type: 'error', signed: true, message: 'worker locale message' });
  await rejected;
  expect(w.terminate).toHaveBeenCalledTimes(1);
});
for (const event of ['error', 'messageerror'] as const)
  test(`${event} terminates instead of retrying PDF work on the main thread`, async () => {
    setup();
    const job = exportPdf(notebook()),
      rejected = expect(job).rejects.toThrow('后台 PDF 导出'),
      w = await started(),
      preventDefault = vi.fn();
    if (event === 'error') {
      w.onerror!({ preventDefault });
      expect(preventDefault).toHaveBeenCalled();
    } else w.onmessageerror!();
    await rejected;
    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(1);
  });
test('pagehide cancels the document worker and removes its lifecycle listener', async () => {
  setup();
  const job = exportPdf(notebook()),
    rejected = expect(job).rejects.toHaveProperty('name', 'AbortError'),
    w = await started();
  window.dispatchEvent(new Event('pagehide'));
  await rejected;
  expect(w.terminate).toHaveBeenCalledTimes(1);
  const retry = exportPdf(notebook()),
    next = await started(1);
  next.reply({ type: 'complete', bytes: new ArrayBuffer(1) });
  await retry;
});
test('a failed progress callback rejects and releases its worker', async () => {
  setup();
  const job = exportPdf(notebook(), {
      onProgress: (p) => {
        if (p.stage === 'saving') throw new Error('callback failed');
      },
    }),
    rejected = expect(job).rejects.toThrow('callback failed'),
    w = await started();
  w.reply({ type: 'progress', progress: { stage: 'saving' } });
  await rejected;
  expect(w.terminate).toHaveBeenCalledTimes(1);
});
