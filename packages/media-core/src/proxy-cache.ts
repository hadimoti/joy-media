import { derivativeCacheKey } from './pipeline.js';
import type { ProxyProfile } from './pipeline.js';

export interface ProxyJobRequest {
  readonly idempotencyKey: string;
  readonly sourceContentHash: string;
  readonly profile: ProxyProfile;
}
export class ProxyCache {
  readonly #entries = new Map<
    string,
    { readonly sourceContentHash: string; readonly derivativeId: string }
  >();
  request(sourceContentHash: string, profile: ProxyProfile): ProxyJobRequest {
    return {
      idempotencyKey: derivativeCacheKey(sourceContentHash, profile),
      sourceContentHash,
      profile,
    };
  }
  store(request: ProxyJobRequest, derivativeId: string): void {
    this.#entries.set(request.idempotencyKey, {
      sourceContentHash: request.sourceContentHash,
      derivativeId,
    });
  }
  lookup(sourceContentHash: string, profile: ProxyProfile): string | undefined {
    return this.#entries.get(derivativeCacheKey(sourceContentHash, profile))?.derivativeId;
  }
  invalidateSource(sourceContentHash: string): void {
    for (const [key, entry] of this.#entries)
      if (entry.sourceContentHash === sourceContentHash) this.#entries.delete(key);
  }
}
