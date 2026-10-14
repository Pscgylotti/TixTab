export interface LatexEdit {
  value: string;
  position: number;
}
/** Bounded session history; typing coalesces without a timer or draft writes. */
export class LatexHistory {
  private past: LatexEdit[] = [];
  private future: LatexEdit[] = [];
  private kind = '';
  private time = 0;
  current: LatexEdit;
  constructor(value: string, position = value.length) {
    this.current = { value, position };
  }
  reset(value: string, position: number) {
    this.current = { value, position };
    this.past = [];
    this.future = [];
    this.kind = '';
  }
  move(position: number) {
    position = Math.max(0, Math.min(this.current.value.length, position));
    if (position !== this.current.position) this.kind = '';
    this.current = { ...this.current, position };
  }
  commit(value: string, position: number, kind = '', time = performance.now()) {
    if (value === this.current.value) {
      this.move(position);
      return;
    }
    const single = !!kind && Math.abs(value.length - this.current.value.length) === 1;
    const merge = single && kind === this.kind && time - this.time < 750 && !this.future.length;
    if (!merge) this.past.push(this.current);
    this.current = { value, position: Math.max(0, Math.min(value.length, position)) };
    this.future = [];
    this.kind = single ? kind : '';
    this.time = time;
    let bytes = this.past.reduce((n, e) => n + e.value.length * 2, 0);
    while (this.past.length > 100 || (bytes > 2_000_000 && this.past.length > 1))
      bytes -= this.past.shift()!.value.length * 2;
  }
  undo() {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push(this.current);
    this.current = entry;
    this.kind = '';
    return entry;
  }
  redo() {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push(this.current);
    this.current = entry;
    this.kind = '';
    return entry;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
