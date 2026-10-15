import type { Page, PlacedImage } from './model';
import { isPicture } from './model';
import type { PDFDocumentProxy } from './pdfTypes';
import { inspectBitmapPages } from './bitmapOcr';
import { bitmapPdfDecoder } from './bitmapPdfDecoder';
import { canvasPng } from './imageDownload';
import { polygonBox } from './pdfNightGeometry';
import { hiddenSourceBitmap } from './correctedBitmap';
export interface ImageExportBridge {
  run: (request: {
    action: 'choose' | 'write' | 'finish';
    token?: string;
    name?: string;
    bytes?: Uint8Array;
  }) => Promise<{
    ok: boolean;
    cancelled?: boolean;
    token?: string;
    directory?: string;
    error?: string;
  }>;
}
export interface ImageSink {
  directory: string;
  write: (name: string, blob: Blob) => Promise<void>;
  close: () => Promise<void>;
}
export async function chooseImageDirectory(): Promise<ImageSink | null> {
  const bridge = window.surfaceDesktop?.imageExport;
  if (bridge) {
    const result = await bridge.run({ action: 'choose' });
    if (result.cancelled) return null;
    if (!result.ok || !result.token) throw Error('image-directory');
    const token = result.token;
    return {
      directory: result.directory!,
      write: async (name, blob) => {
        const saved = await bridge.run({
          action: 'write',
          token,
          name,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        });
        if (!saved.ok) throw Error('image-save');
      },
      close: async () => {
        await bridge.run({ action: 'finish', token });
      },
    };
  }
  const picker = (
    window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
  ).showDirectoryPicker;
  if (!picker) throw Error('image-directory-unavailable');
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await picker.call(window);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
  return {
    directory: directory.name,
    close: async () => {},
    write: async (name, blob) => {
      // Never overwrite an existing export silently.
      for (let i = 0; i < 100; i++) {
        const candidate = i ? name.replace(/\.png$/, ` (${i + 1}).png`) : name;
        try {
          await directory.getFileHandle(candidate);
          continue;
        } catch (e) {
          if (!(e instanceof DOMException) || e.name !== 'NotFoundError') throw e;
        }
        const file = await directory.getFileHandle(candidate, { create: true });
        const writable = await file.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (e) {
          await writable.abort().catch(() => {});
          throw e;
        }
        return;
      }
      throw Error('image-save');
    },
  };
}
export interface ImageExportProgress {
  total: number;
  saved: number;
  skipped: number;
}
/** Enumerate geometry only, then own one decoder/canvas/PNG at a time. */
export async function exportBitmapImages(
  pages: Page[],
  pdf: PDFDocumentProxy | null,
  indices: number[],
  sink: ImageSink,
  signal: AbortSignal,
  onProgress: (p: ImageExportProgress) => void,
) {
  let decoder: ReturnType<typeof bitmapPdfDecoder> | null = null;
  const canvas = document.createElement('canvas');
  let inventory: Awaited<ReturnType<typeof inspectBitmapPages>> | undefined;
  try {
    const selected = indices.map((i) => pages[i]);
    if (selected.some((p) => !p)) throw Error('page-range');
    inventory = await inspectBitmapPages(selected, pdf, signal);
    decoder = pdf ? bitmapPdfDecoder(pdf, signal, 64_000_000) : null;
    const progress: ImageExportProgress = { total: inventory.total, saved: 0, skipped: 0 };
    onProgress({ ...progress });
    const save = async (name: string, draw: () => Promise<boolean>) => {
      signal.throwIfAborted();
      let blob: Blob | undefined;
      try {
        if (!(await draw())) {
          progress.skipped++;
          return;
        }
        signal.throwIfAborted();
        blob = await canvasPng(canvas);
        signal.throwIfAborted();
      } catch (e) {
        signal.throwIfAborted();
        progress.skipped++;
        return;
      } finally {
        canvas.width = canvas.height = 1;
        if (!blob) onProgress({ ...progress });
      }
      // Storage errors stop the job; malformed/unsupported images may be skipped.
      await sink.write(name, blob!);
      blob = undefined;
      progress.saved++;
      onProgress({ ...progress });
    };
    for (const [n, page] of selected.entries()) {
      let image = 0;
      const polygons = inventory.pdfImages.get(page.id) ?? [];
      for (let i = 0; i < polygons.length; i++) {
        if(hiddenSourceBitmap(page,i))continue;
        const box = polygonBox(polygons[i]);
        if (box.width <= 0 || box.height <= 0) continue;
        await save(`page-${indices[n] + 1}-image-${++image}.png`, () =>
          decoder!.draw(page.sourceIndex!, i, canvas),
        );
      }
      const visit = async (object: PlacedImage): Promise<void> => {
        if (object.group) {
          for (const child of object.group.objects) await visit(child);
          return;
        }
        if (!isPicture(object)) return;
        await save(`page-${indices[n] + 1}-image-${++image}.png`, async () => {
          const bitmap = await createImageBitmap(
            await (await fetch(object.data, { signal })).blob(),
          );
          try {
            signal.throwIfAborted();
            if (bitmap.width * bitmap.height > 64_000_000) return false;
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
            return true;
          } finally {
            bitmap.close();
          }
        });
      };
      for (const object of page.images) await visit(object);
    }
    return progress;
  } finally {
    canvas.width = canvas.height = 1;
    inventory?.pdfImages.clear();
    try {
      await decoder?.close();
    } finally {
      await sink.close();
    }
  }
}
