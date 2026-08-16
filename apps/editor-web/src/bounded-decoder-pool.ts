/**
 * Bounded keyed resource pool for preview decoders.
 *
 * Decoder objects own browser media resources (video elements, canvases and
 * decoder state), so an unbounded map would leak memory while scrubbing across
 * many clips. The pool keeps a deterministic LRU and invokes the disposer on
 * every eviction/release.
 */
export interface BoundedDecoderPoolOptions<T> {
  readonly maxEntries: number;
  readonly dispose: (value: T) => void;
}

interface PoolEntry<T> {
  readonly value: T;
  lastUsed: number;
}

export class BoundedDecoderPool<K, T> {
  readonly #entries = new Map<K, PoolEntry<T>>();
  #clock = 0;

  constructor(private readonly options: BoundedDecoderPoolOptions<T>) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)
      throw new RangeError('maxEntries must be a positive safe integer');
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    entry.lastUsed = ++this.#clock;
    return entry.value;
  }

  getOrCreate(key: K, create: () => T): T {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = create();
    this.#entries.set(key, { value, lastUsed: ++this.#clock });
    this.evictIfNeeded(key);
    return value;
  }

  release(key: K): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    this.options.dispose(entry.value);
    return true;
  }

  clear(): void {
    for (const entry of this.#entries.values()) this.options.dispose(entry.value);
    this.#entries.clear();
  }

  keys(): readonly K[] {
    return [...this.#entries.keys()];
  }

  private evictIfNeeded(protectedKey: K): void {
    while (this.#entries.size > this.options.maxEntries) {
      let oldestKey: K | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#entries) {
        if (Object.is(key, protectedKey)) continue;
        if (entry.lastUsed < oldestUse) {
          oldestKey = key;
          oldestUse = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) break;
      this.release(oldestKey);
    }
  }
}
