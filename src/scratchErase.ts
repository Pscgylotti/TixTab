import {
  hitImage,
  hitStroke,
  type Notebook,
  type Page,
  type PlacedImage,
  type Point,
  type Stroke,
} from './model';
import { cullingInkBounds } from './ink';
import { removePageImages } from './pageLayers';
import { SpatialIndex, imageBounds, sweptBounds } from './spatialIndex';
import {
  editablePages,
  replaceEditablePage,
  visitPaperSegments,
  type PaperHit,
} from './scratchPaper';

export interface ErasePreview extends PaperHit {
  strokes: Stroke[];
  images: PlacedImage[];
  occluders: DOMRect[];
}
interface EraseTarget {
  hit: PaperHit;
  ink: SpatialIndex<Stroke>;
  objects: SpatialIndex<PlacedImage>;
  strokes: Map<string, Stroke>;
  images: Map<string, PlacedImage>;
}

/** Gesture-owned indexes and marks. No page mutations or image decoding while
 * dragging; committing all visited sheets creates exactly one undo entry. */
export class ScratchEraseSession {
  private targets = new Map<string, EraseTarget>();
  constructor(
    private hits: PaperHit[],
    private viewport?: DOMRect,
  ) {}

  sample(source: Page, origin: DOMRect, from: Point, to: Point, radius: number) {
    const sx = origin.width / source.width,
      sy = origin.height / source.height;
    if (!(sx > 0 && sy > 0) || radius <= 0) return;
    const screen = ([x, y, p]: Point): Point => [origin.left + x * sx, origin.top + y * sy, p];
    const visit = (a: Point, b: Point) =>
      visitPaperSegments(a, b, this.hits, (hit, a, b) => {
        if (!hit || !(hit.rect.width > 0 && hit.rect.height > 0)) return;
        let target = this.targets.get(hit.page.id);
        if (!target) {
          target = {
            hit,
            ink: new SpatialIndex(cullingInkBounds),
            objects: new SpatialIndex<PlacedImage>(imageBounds),
            strokes: new Map(),
            images: new Map(),
          };
          target.ink.update(hit.page.strokes);
          target.objects.update(hit.page.images);
          this.targets.set(hit.page.id, target);
        }
        const scale = hit.page.width / hit.rect.width;
        const local = ([x, y, p]: Point): Point => [
          (x - hit.rect.left) * scale,
          ((y - hit.rect.top) * hit.page.height) / hit.rect.height,
          p,
        ];
        const start = local(a),
          end = local(b),
          r = radius * sx * scale;
        const box = sweptBounds(start, end, r);
        for (const s of target.ink.search(box, false))
          if (!target.strokes.has(s.id) && hitStroke(s, start, end, r))
            // Keep one stable highlight per hit so its outline/path is cached
            // across animation frames rather than regenerated for every sample.
            target.strokes.set(s.id, {
              ...s,
              tool: 'ballpoint',
              color: '#e05b62',
              size: s.size + 3 * scale,
            });
        for (const image of target.objects.search(box, false))
          if (!target.images.has(image.id) && hitImage(image, start, end, r))
            target.images.set(image.id, image);
      });
    if (this.viewport)
      visitPaperSegments(
        screen(from),
        screen(to),
        [{ page: source, rect: this.viewport }],
        (hit, a, b) => {
          if (hit) visit(a, b);
        },
      );
    else visit(screen(from), screen(to));
  }

  preview(): ErasePreview[] {
    return [...this.targets.values()]
      .filter((t) => t.strokes.size || t.images.size)
      .map((t) => ({
        ...t.hit,
        strokes: [...t.strokes.values()],
        images: [...t.images.values()],
        occluders: this.hits.slice(0, this.hits.indexOf(t.hit)).map((h) => h.rect),
      }));
  }

  apply(notebook: Notebook): Notebook {
    const pages = new Map(editablePages(notebook).map((p) => [p.id, p]));
    // Undo, deletion or a concurrent edit invalidates the entire gesture.
    for (const t of this.targets.values()) {
      const p = pages.get(t.hit.page.id);
      if (!p || p.strokes !== t.hit.page.strokes || p.images !== t.hit.page.images) return notebook;
    }
    let next = notebook;
    for (const t of this.targets.values()) {
      if (!t.strokes.size && !t.images.size) continue;
      const p = pages.get(t.hit.page.id)!;
      next = replaceEditablePage(next, {
        ...removePageImages(p, [...t.images.keys()]),
        strokes: p.strokes.filter((s) => !t.strokes.has(s.id)),
      });
    }
    return next;
  }
}
