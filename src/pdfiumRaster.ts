import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { getPdfRenderBackend, subscribeAppearance } from './appearance';
import type { PdfiumRequest, PdfiumResponse, PdfiumRegion, PdfiumPageInfo } from './pdfiumProtocol';
import { abortWait } from './abortWait';

export interface PdfRasterTask {
  promise: Promise<void>;
  cancel: (extraDelay?: number) => void;
  onContinue?: RenderTask['onContinue'];
}
type Reply = Exclude<PdfiumResponse, { type: 'continue' | 'error' | 'released' }>;
interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  onContinue?: (resume: () => void) => void;
  dispose: () => void;
}
const cancelled = () =>
  Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' });
const sessions = new WeakMap<PDFDocumentProxy, Session>(),
  live = new Set<Session>();
let renders = 0,
  initializations = 0,
  sequence = 0,
  resident: Engine | undefined;
/** Keep the compiled engine alive; document buffers are independently released. */
class Engine {
  readonly worker = new Worker(new URL('./pdfium.worker.ts', import.meta.url), { type: 'module' });
  readonly routes = new Map<number, Session>();
  readonly releases = new Set<number>();
  heapBytes = 0;
  documents = 0;
  fail(error = new Error('PDFium Worker failed')) {
    this.worker.terminate();
    if (resident === this) resident = undefined;
    for (const session of [...live]) if (session.engine === this) session.close(error, false);
    this.routes.clear();
    this.releases.clear();
  }
  constructor(readonly isolated = false) {
    if (!isolated) initializations++;
    const failed = () => this.fail();
    this.worker.onerror = failed;
    this.worker.onmessageerror = failed;
    this.worker.onmessage = ({ data }: MessageEvent<PdfiumResponse>) => {
      if (data.type === 'released') {
        this.heapBytes = data.heapBytes;
        this.documents = data.documents;
        this.releases.delete(data.id);
        return;
      }
      if (data.type === 'opened') this.documents = data.documents;
      const session = this.routes.get(data.id);
      if (session) session.receive(data);
      else if (data.type === 'rendered' || data.type === 'original-image') data.bitmap?.close();
    };
  }
  release(documentId: number) {
    const id = ++sequence;
    this.releases.add(id);
    this.worker.postMessage({ type: 'release', id, documentId } satisfies PdfiumRequest);
  }
}
class Session {
  readonly documentId = ++sequence;
  readonly ready: Promise<void>;
  readonly pending = new Map<number, Pending>();
  closed = false;
  pages: PdfiumPageInfo[] = [];
  imageSupport: boolean[] = [];
  private readonly lifetime = new AbortController();
  constructor(
    pdf: PDFDocumentProxy,
    owned?: Uint8Array,
    readonly engine = (resident ??= new Engine()),
    imageSupport?: boolean[],
  ) {
    live.add(this);
    const loadTimeout = setTimeout(
      () => this.engine.fail(new Error('PDFium document load timed out')),
      30000,
    );
    this.ready = (async () => {
      const data = owned ?? (await abortWait(pdf.getData(), this.lifetime.signal));
      if (this.closed) throw cancelled();
      // getData returns owned bytes. The isolated decoder can transfer that
      // result directly rather than cloning the entire file a second time.
      const bytes = owned ?? (this.engine.isolated ? data : data.slice());
      await this.request(
        { type: 'open', id: ++sequence, documentId: this.documentId, bytes, imageSupport },
        [bytes.buffer],
      );
    })().finally(() => clearTimeout(loadTimeout));
    void this.ready.catch(() => this.close());
  }
  receive(data: Exclude<PdfiumResponse, { type: 'released' }>) {
    const pending = this.pending.get(data.id);
    if (data.type === 'continue') {
      const resume = () => {
        if (!this.closed)
          this.engine.worker.postMessage({ type: 'resume', id: data.id } satisfies PdfiumRequest);
      };
      if (pending?.onContinue) pending.onContinue(resume);
      else resume();
      return;
    }
    if (!pending) {
      if (data.type === 'rendered' || data.type === 'original-image') data.bitmap?.close();
      return;
    }
    this.pending.delete(data.id);
    this.engine.routes.delete(data.id);
    pending.dispose();
    if (data.type === 'error')
      pending.reject(data.error === 'cancelled' ? cancelled() : new Error(data.error));
    else {
      if (data.type === 'opened') {
        this.pages = data.pages;
        this.imageSupport = data.imageSupport ?? [];
      }
      if (data.type === 'rendered') {
        this.engine.heapBytes = data.heapBytes;
        renders++;
      }
      pending.resolve(data);
    }
  }
  close(error = cancelled(), release = true) {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const [id, pending] of this.pending) {
      this.engine.routes.delete(id);
      if (release && !this.engine.isolated) {
        try {
          this.engine.worker.postMessage({ type: 'cancel', id } satisfies PdfiumRequest);
        } catch {}
      }
      pending.dispose();
      pending.reject(error);
    }
    this.pending.clear();
    this.pages = [];
    this.imageSupport = [];
    live.delete(this);
    if (release) {
      if (this.engine.isolated) this.engine.fail(error);
      else this.engine.release(this.documentId);
    }
  }
  request(
    message: Exclude<PdfiumRequest, { type: 'release' | 'resume' | 'cancel' }>,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
    onContinue?: Pending['onContinue'],
  ) {
    return new Promise<Reply>((resolve, reject) => {
      if (this.closed || signal?.aborted) {
        reject(cancelled());
        return;
      }
      const abort = () => {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        this.engine.routes.delete(message.id);
        entry.dispose();
        this.engine.worker.postMessage({ type: 'cancel', id: message.id } satisfies PdfiumRequest);
        reject(cancelled());
      };
      const timer = setTimeout(() => this.engine.fail(new Error('PDFium render timed out')), 30000);
      this.pending.set(message.id, {
        resolve,
        reject,
        onContinue,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        },
      });
      this.engine.routes.set(message.id, this);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.engine.worker.postMessage(message, transfer);
      } catch {
        this.close(new Error('PDFium request failed'));
      }
    });
  }
  render(
    page: number,
    fullWidth: number,
    fullHeight: number,
    region: PdfiumRegion,
    signal: AbortSignal,
    onContinue: Pending['onContinue'],
  ) {
    return this.request(
      {
        type: 'render',
        id: ++sequence,
        documentId: this.documentId,
        page,
        fullWidth,
        fullHeight,
        region,
      },
      [],
      signal,
      onContinue,
    );
  }
}
export async function openPdfiumDocument(pdf: PDFDocumentProxy, bytes: Uint8Array) {
  const session = new Session(pdf, bytes.slice());
  sessions.set(pdf, session);
  await session.ready;
  return session.pages;
}
type Query =
  | { type: 'outline' }
  | { type: 'destination'; name: string }
  | { type: 'annotations'; page: number }
  | { type: 'text'; page: number }
  | { type: 'images'; page: number };
export async function queryPdfium(pdf: PDFDocumentProxy, query: Query) {
  const session = sessionFor(pdf);
  await session.ready;
  return session.request({ ...query, id: ++sequence, documentId: session.documentId });
}
function sessionFor(pdf: PDFDocumentProxy) {
  let session = sessions.get(pdf);
  if (!session || session.closed) {
    session = new Session(pdf);
    sessions.set(pdf, session);
  }
  return session;
}
export function releasePdfium(pdf: PDFDocumentProxy) {
  sessions.get(pdf)?.close();
  sessions.delete(pdf);
}
subscribeAppearance(() => {
  if (getPdfRenderBackend() !== 'pdfium') for (const session of [...live]) session.close();
});
export function getPdfiumStats() {
  return {
    workers: resident ? 1 : 0,
    decoderWorkers: [...live].filter((s) => s.engine.isolated).length,
    documents: resident?.documents ?? 0,
    sessions: live.size,
    initializations,
    pending: (resident?.routes.size ?? 0) + (resident?.releases.size ?? 0),
    heapBytes: resident?.heapBytes ?? 0,
    renders,
  };
}

/** A batch owns one decoder heap. Reader engine residency is unaffected, and
 * stopping never waits for a synchronous native image decoder to acknowledge. */
export function createPdfiumImageDecoder(
  pdf: PDFDocumentProxy,
  signal: AbortSignal,
  maxPixels = 4_000_000,
) {
  const owner = sessions.get(pdf);
  const hints =
    owner && !owner.closed && owner.imageSupport.length === pdf.numPages
      ? [...owner.imageSupport]
      : undefined;
  const session = new Session(pdf, undefined, new Engine(true), hints);
  const abort = () => session.close();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return {
    async draw(page: number, image: number, canvas: HTMLCanvasElement) {
      await abortWait(session.ready, signal);
      signal.throwIfAborted();
      const reply = await session.request(
        {
          type: 'original-image',
          id: ++sequence,
          documentId: session.documentId,
          page,
          image,
          maxPixels,
        },
        [],
        signal,
      );
      if (reply.type !== 'original-image') throw new Error('PDFium image unavailable');
      const bitmap = reply.bitmap;
      if (!bitmap) return false;
      try {
        signal.throwIfAborted();
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        return true;
      } finally {
        bitmap.close();
      }
    },
    close() {
      signal.removeEventListener('abort', abort);
      session.close();
    },
  };
}
export function renderPdfium(
  pdf: PDFDocumentProxy,
  page: number,
  canvas: HTMLCanvasElement,
  fullWidth: number,
  fullHeight: number,
  region: PdfiumRegion,
): PdfRasterTask {
  const abort = new AbortController();
  const task: PdfRasterTask = { cancel: () => abort.abort(), promise: Promise.resolve() };
  task.promise = (async () => {
    const session = sessionFor(pdf);
    await abortWait(session.ready, abort.signal);
    abort.signal.throwIfAborted();
    const reply = await session.render(
      page,
      fullWidth,
      fullHeight,
      region,
      abort.signal,
      (resume) => (task.onContinue ? task.onContinue(resume) : resume()),
    );
    if (reply.type !== 'rendered') throw new Error('PDFium bitmap missing');
    try {
      abort.signal.throwIfAborted();
      canvas.getContext('2d')!.drawImage(reply.bitmap, 0, 0);
      canvas.dataset.pdfBackend = 'pdfium';
    } finally {
      reply.bitmap.close();
    }
  })();
  return task;
}
