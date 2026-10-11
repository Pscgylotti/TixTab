interface Position {
  x: number;
  y: number;
}
export class PanZoomPointers {
  private points = new Map<number, { x: number; y: number }>();
  private previous: ReturnType<PanZoomPointers['geometry']> = null;
  has(id: number) {
    return this.points.has(id);
  }
  down(id: number, x: number, y: number) {
    this.points.set(id, { x, y });
    this.previous = this.geometry();
  }
  move(id: number, x: number, y: number) {
    if (this.points.has(id)) this.points.set(id, { x, y });
  }
  take() {
    const current = this.geometry(),
      previous = this.previous;
    this.previous = current;
    if (!current || !previous || current.count !== previous.count) return null;
    return {
      dx: current.x - previous.x,
      dy: current.y - previous.y,
      x: previous.x,
      y: previous.y,
      scale:
        current.count === 2 && previous.distance > 18 ? current.distance / previous.distance : 1,
    };
  }
  up(id: number) {
    this.points.delete(id);
    this.previous = this.geometry();
  }
  reset() {
    this.points.clear();
    this.previous = null;
  }
  private geometry(): (Position & { distance: number; count: number }) | null {
    if (!this.points.size || this.points.size > 2) return null;
    const [a, b = a] = [...this.points.values()];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      count: this.points.size,
    };
  }
}
