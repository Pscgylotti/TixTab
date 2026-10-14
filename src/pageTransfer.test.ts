import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { extractPage, extractPages } from './pageTransferEngine';
import { blankPage } from './model';
import { clonePage } from './duplicatePage';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createImageExport } = createRequire(import.meta.url)('../electron/image-export.cjs');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('detached page and bounded clipboard', () => {
  it('extracts a mixed multi-page bundle once with shared backgrounds and preserved order', async () => {
    const input = await PDFDocument.create();
    input.addPage([200, 300]);
    input.addPage([400, 500]);
    input.addPage([600, 700]);
    const pages = [
      { ...blankPage(600, 700), sourceIndex: 2 },
      blankPage(210, 297),
      { ...blankPage(200, 300), sourceIndex: 0 },
      { ...blankPage(600, 700), sourceIndex: 2 },
    ];
    const bundle = await extractPages(await input.save(), pages);
    expect(bundle.pages!.map((p) => p.sourceIndex)).toEqual([0, null, 1, 0]);
    const pdf = await PDFDocument.load(bundle.source!);
    expect(pdf.getPages().map((p) => p.getSize())).toEqual([
      { width: 600, height: 700 },
      { width: 200, height: 300 },
    ]);
    expect(pages[0].sourceIndex).toBe(2);
  });
  it('pastes a blank-page bundle as fresh editable pages in one notebook change', async () => {
    const { newNotebook } = await import('./model');
    const { copyNotebookPages, pasteNotebookPage } = await import('./pageTransfer');
    const source = newNotebook();
    source.pages = [blankPage(200, 300), blankPage(400, 500), blankPage(600, 700)];
    const signal = new AbortController().signal;
    const bundle = await copyNotebookPages(source, [2, 0, 2], signal);
    const target = newNotebook(),
      result = await pasteNotebookPage(target, 0, bundle, signal);
    expect(result.pages.map((p) => p.width)).toEqual([target.pages[0].width, 200, 600]);
    expect(result.pages[1].id).not.toBe(source.pages[0].id);
    expect(target.pages).toHaveLength(1);
  });
  it('extracts just one source page with geometry/annotations, URI links and static form appearance', async () => {
    const pdf = await PDFDocument.create(),
      a = pdf.addPage([200, 300]),
      b = pdf.addPage([700, 900]);
    const uri = pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 20, 20],
        A: { S: 'URI', URI: 'https://example.com' },
      }),
    );
    const go = pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [20, 0, 40, 20],
        Dest: [b.ref, PDFName.of('Fit')],
      }),
    );
    a.node.set(PDFName.of('Annots'), pdf.context.obj([uri, go]));
    const field = pdf.getForm().createTextField('name');
    field.setText('Appearance');
    field.addToPage(a, { x: 30, y: 40, width: 100, height: 30 });
    const bytes = await pdf.save();
    const page = { ...blankPage(200, 300), sourceIndex: 0 };
    const snapshot = await extractPage(bytes, page);
    const result = await PDFDocument.load(snapshot.source!);
    expect(result.getPageCount()).toBe(1);
    expect(result.getPage(0).getSize()).toEqual({ width: 200, height: 300 });
    const annotations = result
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((ref) => result.context.lookup(ref) as PDFDict);
    expect(annotations[0].lookup(PDFName.of('A'), PDFDict).get(PDFName.of('S'))).toBe(
      PDFName.of('URI'),
    );
    expect(annotations[1].has(PDFName.of('Dest'))).toBe(false);
    expect(annotations[2].get(PDFName.of('Subtype'))).toBe(PDFName.of('Stamp'));
    expect(annotations[2].has(PDFName.of('Parent'))).toBe(false);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });
  it('copies nested IDs and metadata without sharing mutable OCR/review data', () => {
    const original = blankPage();
    original.reviews = [{ id: 'r', text: 'note', region: { x: 1, y: 2, width: 3, height: 4 } }];
    original.bitmapOcr = [
      {
        imageIndex: 0,
        polygon: [0, 0, 1, 0, 1, 1, 0, 1],
        result: { text: 'word', engine: 'test', lines: [] },
      } as any,
    ];
    const copy = clonePage(original);
    copy.reviews![0].region.x = 88;
    copy.bitmapOcr![0].polygon[0] = 55;
    expect(original.reviews[0].region.x).toBe(1);
    expect(original.bitmapOcr[0].polygon[0]).toBe(0);
    expect(copy.id).not.toBe(original.id);
    expect(copy.reviews![0].id).not.toBe('r');
  });
  it('retains one clipboard payload, replaces/clears it and rejects oversized pages', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const clipboard = await import('./pageClipboard');
    const { PAGE_CLIPBOARD_LIMIT } = await import('./pageTransfer');
    await clipboard.storeCopiedPage({ page: blankPage(), source: new Uint8Array(100) });
    expect(clipboard.pageClipboardStats().entries).toBe(1);
    await clipboard.storeCopiedPage({ page: blankPage(), source: null });
    expect(clipboard.getCopiedPage()!.source).toBeNull();
    await expect(
      clipboard.storeCopiedPage({
        page: blankPage(),
        source: new Uint8Array(PAGE_CLIPBOARD_LIMIT + 1),
      }),
    ).rejects.toThrow('page-clipboard-large');
    clipboard.clearPageClipboard();
    expect(clipboard.pageClipboardStats()).toEqual({ entries: 0, bytes: 0 });
  });
});
describe('native folder capability', () => {
  it('writes PNG without overwriting; rejects traversal, wrong owners and finished tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tixtab-image-export-')),
      owner = {};
    const exporter = createImageExport({ chooseDirectory: async () => root });
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    try {
      const chosen = await exporter.run(owner, { action: 'choose' });
      expect(chosen.ok).toBe(true);
      const request = {
        action: 'write',
        token: chosen.token,
        name: 'page-1-image-1.png',
        bytes: png,
      };
      expect((await exporter.run({}, request)).ok).toBe(false);
      expect((await exporter.run(owner, { ...request, name: '../bad.png' })).ok).toBe(false);
      expect((await exporter.run(owner, request)).name).toBe('page-1-image-1.png');
      expect((await exporter.run(owner, request)).name).toBe('page-1-image-1 (2).png');
      expect(await readFile(join(root, request.name))).toEqual(Buffer.from(png));
      await exporter.run(owner, { action: 'finish', token: chosen.token });
      expect((await exporter.run(owner, request)).ok).toBe(false);
    } finally {
      exporter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not recreate a directory lease after cancellation during the picker', async () => {
    let release!: (value: string) => void;
    const root = await mkdtemp(join(tmpdir(), 'tixtab-image-picker-')),
      owner = {};
    const exporter = createImageExport({
      chooseDirectory: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    try {
      const job = exporter.run(owner, { action: 'choose' });
      exporter.cancel(owner);
      release(root);
      expect((await job).cancelled).toBe(true);
    } finally {
      exporter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('terminates a page-transfer worker and removes lifecycle timers on abort/error', async () => {
  const { copyNotebookPage } = await import('./pageTransfer');
  const workers: any[] = [];
  class MockWorker {
    onmessage: any;
    onerror: any;
    onmessageerror: any;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
      workers.push(this);
    }
  }
  vi.useFakeTimers();
  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('window', new EventTarget());
  const notebook = {
    version: 1 as const,
    name: 'worker',
    source: new Uint8Array([1]),
    pages: [{ ...blankPage(), sourceIndex: 0 }],
  };
  try {
    const owner = new AbortController();
    const pending = copyNotebookPage(notebook, 0, owner.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    owner.abort();
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[0].onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const failing = copyNotebookPage(notebook, 0, new AbortController().signal);
    const error = expect(failing).rejects.toThrow('page-transfer');
    workers[1].onmessageerror();
    await error;
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
