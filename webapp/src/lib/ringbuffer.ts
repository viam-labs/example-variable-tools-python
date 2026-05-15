/** Time-windowed (timestamp_ms, value) buffer.
 *
 * Stores samples and prunes anything older than ``windowMs`` from the most
 * recent sample's timestamp on every push. Two parallel arrays are used so
 * snapshot is a cheap slice. Suitable for the polling rates this app sees
 * (1-30 Hz × tens of buffers); array shifts are O(n) but n is bounded by
 * windowMs × pollRate which is tiny in practice.
 */
export class TimeWindowBuffer {
  private xs: number[] = [];
  private ys: number[] = [];
  private windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  setWindow(windowMs: number): void {
    this.windowMs = windowMs;
    this._prune();
  }

  push(ts: number, value: number): void {
    this.xs.push(ts);
    this.ys.push(value);
    this._prune();
  }

  private _prune(): void {
    if (this.xs.length === 0) return;
    const cutoff = this.xs[this.xs.length - 1] - this.windowMs;
    let i = 0;
    while (i < this.xs.length && this.xs[i] < cutoff) i += 1;
    if (i > 0) {
      this.xs = this.xs.slice(i);
      this.ys = this.ys.slice(i);
    }
  }

  /** [xs, ys] snapshot copies. */
  snapshot(): [number[], number[]] {
    return [this.xs.slice(), this.ys.slice()];
  }

  get length(): number {
    return this.xs.length;
  }

  last(): { ts: number; value: number } | undefined {
    if (this.xs.length === 0) return undefined;
    const i = this.xs.length - 1;
    return { ts: this.xs[i], value: this.ys[i] };
  }

  /** Most recent sample at or before ``ts``, or undefined if none. Binary
   * search; O(log n). */
  valueAt(ts: number): number | undefined {
    if (this.xs.length === 0) return undefined;
    if (this.xs[0] > ts) return undefined;
    let lo = 0;
    let hi = this.xs.length - 1;
    if (this.xs[hi] <= ts) return this.ys[hi];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.xs[mid] <= ts) lo = mid;
      else hi = mid - 1;
    }
    return this.ys[lo];
  }

  clear(): void {
    this.xs = [];
    this.ys = [];
  }
}

/** Backward-compat alias — older imports of `RingBuffer` continue to work. */
export const RingBuffer = TimeWindowBuffer;
export type RingBuffer = TimeWindowBuffer;
