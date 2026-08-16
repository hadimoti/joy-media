export interface BoundedFrameStoreOptions<K, V> {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly estimateBytes?: (value: V) => number;
  readonly onEvict?: (key: K, value: V) => void;
}

interface FrameEntry<V> {
  readonly value: V;
  readonly bytes: number;
  readonly requestToken: number;
}

/** LRU frame store with per-source latest-request tokens and explicit bounds. */
export class BoundedFrameStore<K, V> implements ReadonlyMap<K, V> {
  readonly #entries = new Map<K, FrameEntry<V>>();
  readonly #requestTokens = new Map<K, number>();
  readonly #estimateBytes: (value: V) => number;
  readonly #onEvict: ((key: K, value: V) => void) | undefined;
  #totalBytes = 0;

  constructor(private readonly options: BoundedFrameStoreOptions<K, V>) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)
      throw new Error('maxEntries must be a positive safe integer');
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
      throw new Error('maxBytes must be a positive safe integer');
    this.#estimateBytes = options.estimateBytes ?? defaultByteEstimate;
    this.#onEvict = options.onEvict;
  }

  get size(): number {
    return this.#entries.size;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  beginRequest(key: K): number {
    const next = (this.#requestTokens.get(key) ?? 0) + 1;
    this.#requestTokens.set(key, next);
    return next;
  }

  isCurrent(key: K, token: number): boolean {
    return this.#requestTokens.get(key) === token;
  }

  /** Stores only if the request is still the latest request for this source. */
  put(key: K, value: V, requestToken?: number): boolean {
    if (requestToken !== undefined && !this.isCurrent(key, requestToken)) return false;
    const bytes = Math.max(0, Math.round(this.#estimateBytes(value)));
    const previous = this.#entries.get(key);
    if (previous !== undefined) this.#totalBytes -= previous.bytes;
    this.#entries.delete(key);
    this.#entries.set(key, {
      value,
      bytes,
      requestToken: requestToken ?? this.#requestTokens.get(key) ?? 0,
    });
    this.#totalBytes += bytes;
    this.evictIfNeeded();
    return this.#entries.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  delete(key: K): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    this.#totalBytes -= entry.bytes;
    this.#onEvict?.(key, entry.value);
    return true;
  }

  clear(): void {
    for (const [key, entry] of this.#entries) this.#onEvict?.(key, entry.value);
    this.#entries.clear();
    this.#requestTokens.clear();
    this.#totalBytes = 0;
  }

  entries(): MapIterator<[K, V]> {
    return this.valuesWithKeys();
  }

  *valuesWithKeys(): Generator<[K, V]> {
    for (const [key, entry] of this.#entries) yield [key, entry.value];
  }

  *keys(): Generator<K> {
    yield* this.#entries.keys();
  }

  *values(): Generator<V> {
    for (const entry of this.#entries.values()) yield entry.value;
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, entry] of this.#entries) callbackfn.call(thisArg, entry.value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  private evictIfNeeded(): void {
    while (
      this.#entries.size > this.options.maxEntries ||
      this.#totalBytes > this.options.maxBytes
    ) {
      const oldest = this.#entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}

function defaultByteEstimate(value: unknown): number {
  if (value !== null && typeof value === 'object' && 'data' in value) {
    const data = (value as { data?: unknown }).data;
    if (data !== null && typeof data === 'object' && 'byteLength' in data) {
      const byteLength = (data as { byteLength?: unknown }).byteLength;
      if (typeof byteLength === 'number' && Number.isFinite(byteLength)) return byteLength;
    }
  }
  return 1;
}
