import RBush from 'rbush';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Entry<T> extends Bounds {
  value: T;
  order: number;
}
export const overlaps = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
export function unionBounds(boxes: readonly Bounds[]): Bounds | undefined {
  if (!boxes.length) return;
  const result = { ...boxes[0] };
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    result.minX = Math.min(result.minX, b.minX);
    result.minY = Math.min(result.minY, b.minY);
    result.maxX = Math.max(result.maxX, b.maxX);
    result.maxY = Math.max(result.maxY, b.maxY);
  }
  return result;
}
export function sweptBounds(
  from: readonly number[],
  to: readonly number[],
  radius: number,
): Bounds {
  return {
    minX: Math.min(from[0], to[0]) - radius,
    minY: Math.min(from[1], to[1]) - radius,
    maxX: Math.max(from[0], to[0]) + radius,
    maxY: Math.max(from[1], to[1]) + radius,
  };
}
export const imageBounds = (image: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Bounds => ({
  minX: image.x,
  minY: image.y,
  maxX: image.x + image.width,
  maxY: image.y + image.height,
});

/** One mutable, two-dimensional bounding hierarchy per live page. Immutable
 * element references preserve geometry across undo/redo; history arrays never
 * retain trees. Small scenes avoid tree overhead. Search results keep layer order. */
export class SpatialIndex<T extends object> {
  private tree = new RBush<Entry<T>>();
  private entries: Entry<T>[] = [];
  private items: readonly T[] = [];
  private indexed = false;
  readonly stats = { bounds: 0, builds: 0, inserts: 0, removes: 0, searches: 0, candidates: 0 };

  constructor(
    private bounds: (item: T) => Bounds,
    private threshold = 64,
  ) {}

  matches(items: readonly T[] | undefined) {
    return this.items === items;
  }

  update(items: readonly T[]) {
    const added: Entry<T>[] = [],
      removed: Entry<T>[] = [];
    let reordered = false;
    if (items === this.items) return { added, removed, reordered };
    const previous = this.entries;
    let append = items.length >= previous.length;
    if (append)
      for (let i = 0; i < previous.length; i++)
        if (previous[i].value !== items[i]) {
          append = false;
          break;
        }
    const entry = (value: T, order: number): Entry<T> => {
      this.stats.bounds++;
      return { ...this.bounds(value), value, order };
    };
    if (append) {
      for (let i = previous.length; i < items.length; i++) added.push(entry(items[i], i));
      // Do not mutate an entry array retained by a caller of update().
      this.entries = [...previous, ...added];
    } else {
      // Queues also preserve repeated references rather than silently dropping them.
      const available = new Map<T, { entries: Entry<T>[]; used: number }>();
      for (const e of previous) {
        const list = available.get(e.value);
        if (list) list.entries.push(e);
        else available.set(e.value, { entries: [e], used: 0 });
      }
      let lastOrder = -1;
      this.entries = items.map((value, order) => {
        const list = available.get(value),
          existing = list?.entries[list.used++];
        if (!existing) {
          const e = entry(value, order);
          added.push(e);
          return e;
        }
        if (existing.order < lastOrder) reordered = true;
        lastOrder = existing.order;
        existing.order = order;
        return existing;
      });
      for (const list of available.values()) removed.push(...list.entries.slice(list.used));
    }
    if (items.length < this.threshold) {
      if (this.indexed) this.tree.clear();
      this.indexed = false;
    } else if (!this.indexed || added.length + removed.length > Math.max(64, items.length / 3)) {
      this.tree.clear().load(this.entries);
      this.stats.builds++;
      this.indexed = true;
    } else {
      for (const e of removed) this.tree.remove(e);
      for (const e of added) this.tree.insert(e);
      this.stats.removes += removed.length;
      this.stats.inserts += added.length;
    }
    this.items = items;
    return { added, removed, reordered };
  }

  search(box: Bounds, ordered = true): T[] {
    this.stats.searches++;
    const found = this.indexed
      ? this.tree.search(box)
      : this.entries.filter((entry) => overlaps(entry, box));
    if (ordered && this.indexed) found.sort((a, b) => a.order - b.order);
    this.stats.candidates += found.length;
    return found.map((entry) => entry.value);
  }
}
