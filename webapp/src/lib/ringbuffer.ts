/** Fixed-capacity ring buffer of (timestamp_ms, value) samples. Two parallel
 * arrays are exposed so uPlot can read them as typed-array-like sequences
 * without a copy. */
export class RingBuffer {
  readonly capacity: number;
  private xs: Float64Array;
  private ys: Float64Array;
  private head = 0; // next write index
  private size = 0;

  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.xs = new Float64Array(capacity);
    this.ys = new Float64Array(capacity);
  }

  push(ts: number, value: number): void {
    this.xs[this.head] = ts;
    this.ys[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Returns [xs, ys] in chronological order. Allocates two new arrays — call
   * sparingly (uPlot setData is the primary consumer, runs ~10 Hz). */
  snapshot(): [number[], number[]] {
    const xs: number[] = new Array(this.size);
    const ys: number[] = new Array(this.size);
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      const j = (start + i) % this.capacity;
      xs[i] = this.xs[j];
      ys[i] = this.ys[j];
    }
    return [xs, ys];
  }

  /** Most recent sample, or undefined if empty. */
  last(): { ts: number; value: number } | undefined {
    if (this.size === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return { ts: this.xs[idx], value: this.ys[idx] };
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}
