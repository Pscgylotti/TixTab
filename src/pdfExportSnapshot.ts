import type { Notebook, Point } from './model';
import { cancelledPdfExport, type PackedNotebook, type PackedStroke } from './pdfExportProtocol';
import { cachedInkPath, rememberInkPath } from './ink';

/** Export only the needed drawing data: do not clone SVG previews, scenes,
 * macros or other editable project payloads. Double precision pressure/points
 * and a private source copy are transferred, never the notebook's own buffers. */
export async function packPdfExport(notebook: Notebook, signal: AbortSignal) {
  const transfers: ArrayBuffer[] = [],
    pages: PackedNotebook['pages'] = [];
  let deadline = performance.now() + 6;
  const check = () => {
    if (signal.aborted) throw cancelledPdfExport();
  };
  const yieldIfNeeded = async () => {
    check();
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      check();
      deadline = performance.now() + 6;
    }
  };
  check();
  let source: Uint8Array | null = null;
  if (notebook.source) {
    source = new Uint8Array(notebook.source.length);
    for (let start = 0; start < source.length; start += 1024 * 1024) {
      source.set(notebook.source.subarray(start, start + 1024 * 1024), start);
      await yieldIfNeeded();
    }
    transfers.push(source.buffer as ArrayBuffer);
  }
  for (const page of notebook.pages) {
    const strokes: PackedStroke[] = [];
    for (const stroke of page.strokes) {
      const path = cachedInkPath(stroke);
      if (path !== undefined) {
        strokes.push({
          id: stroke.id,
          tool: stroke.tool,
          color: stroke.color,
          size: stroke.size,
          path,
        });
        await yieldIfNeeded();
        continue;
      }
      const points = new Float64Array(stroke.points.length * 3);
      for (let start = 0; start < stroke.points.length; start += 16384) {
        const end = Math.min(start + 16384, stroke.points.length);
        for (let i = start; i < end; i++) {
          const p = stroke.points[i];
          points[i * 3] = p[0];
          points[i * 3 + 1] = p[1];
          points[i * 3 + 2] = p[2];
        }
        await yieldIfNeeded();
      }
      strokes.push({
        id: stroke.id,
        tool: stroke.tool,
        color: stroke.color,
        size: stroke.size,
        points,
      });
      transfers.push(points.buffer as ArrayBuffer);
    }
    pages.push({
      id: page.id,
      sourceIndex: page.sourceIndex,
      width: page.width,
      height: page.height,
      paper: page.paper,
      strokes,
      images: page.images.map((image) => ({
        id: image.id,
        kind: image.kind,
        data: image.data,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      })),
    });
    await yieldIfNeeded();
  }
  check();
  return {
    notebook: { version: notebook.version, name: notebook.name, source, pages } as PackedNotebook,
    transfers,
  };
}

export function unpackPdfExport(packed: PackedNotebook): Notebook {
  return {
    ...packed,
    pages: packed.pages.map((page) => ({
      ...page,
      strokes: page.strokes.map((stroke) => {
        if (typeof stroke.path === 'string') {
          const value = {
            id: stroke.id,
            tool: stroke.tool,
            color: stroke.color,
            size: stroke.size,
            points: [],
          };
          rememberInkPath(value, stroke.path);
          return value;
        }
        if (!(stroke.points instanceof Float64Array) || stroke.points.length % 3)
          throw new Error('Invalid PDF export point buffer');
        const points: Point[] = new Array(stroke.points.length / 3);
        for (let i = 0; i < points.length; i++)
          points[i] = [stroke.points[i * 3], stroke.points[i * 3 + 1], stroke.points[i * 3 + 2]];
        return { ...stroke, points };
      }),
    })),
  };
}
