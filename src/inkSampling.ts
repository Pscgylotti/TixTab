/** Raw updates and pointermove can contain the same coalesced hardware samples.
 * Retain chronological input once, with bounded bookkeeping for coarse clocks. */
export class InkSampleClock {
  private time = -Infinity;
  private sameTime = new Set<string>();
  reset() {
    this.time = -Infinity;
    this.sameTime.clear();
  }
  accept(time: number, x: number, y: number, pressure: number) {
    if (time < this.time) return false;
    if (time > this.time) {
      this.time = time;
      this.sameTime.clear();
    }
    const key = `${x}:${y}:${pressure}`;
    if (this.sameTime.has(key)) return false;
    this.sameTime.add(key);
    if (this.sameTime.size > 64) this.sameTime.delete(this.sameTime.values().next().value!);
    return true;
  }
}
