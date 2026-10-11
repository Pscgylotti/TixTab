/** Bounded kinetic scrolling in CSS pixels; no timer runs while idle. */
export class ScrollVelocity {
  private samples: { x: number; y: number; t: number }[] = [];
  private lastMove = 0;
  reset() {
    this.samples = [];
    this.lastMove = 0;
  }
  add(x: number, y: number, t: number) {
    const last = this.samples.at(-1);
    if (!last || x !== last.x || y !== last.y) this.lastMove = t;
    this.samples.push({ x, y, t });
    this.samples = this.samples.filter((p) => t - p.t <= 110).slice(-20);
  }
  release(t: number) {
    const first = this.samples[0],
      last = this.samples.at(-1);
    if (!first || !last || t - this.lastMove > 80 || last.t - first.t < 12) return { x: 0, y: 0 };
    const dt = last.t - first.t,
      clamp = (v: number) => Math.max(-3, Math.min(3, v));
    return { x: clamp((first.x - last.x) / dt), y: clamp((first.y - last.y) / dt) };
  }
}
export function inertiaStep(velocity: { x: number; y: number }, elapsed: number) {
  const dt = Math.max(0, Math.min(40, elapsed)),
    decay = Math.exp(-dt / 270),
    distance = 270 * (1 - decay);
  return {
    dx: velocity.x * distance,
    dy: velocity.y * distance,
    velocity: { x: velocity.x * decay, y: velocity.y * decay },
    done: Math.hypot(velocity.x * decay, velocity.y * decay) < 0.035,
  };
}
