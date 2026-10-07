/**
 * Fixed-size buffer that keeps the most recent events. Each event gets an
 * increasing `seq`, so callers can read incrementally with `since_seq`
 * instead of re-reading (and re-paying tokens for) the whole buffer.
 */
export class RingBuffer<T extends { seq: number }> {
  private items: T[] = [];
  private nextSeq = 1;
  dropped = 0;

  constructor(private readonly capacity: number) {}

  push(item: Omit<T, "seq">): T {
    const entry = { ...item, seq: this.nextSeq++ } as T;
    this.items.push(entry);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped++;
    }
    return entry;
  }

  all(): readonly T[] {
    return this.items;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }
}
