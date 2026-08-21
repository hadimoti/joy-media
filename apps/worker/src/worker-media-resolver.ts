import { existsSync } from 'node:fs';

export type WorkerResolvedMedia =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'html-scene'; readonly packageId: string };

export interface WorkerMediaResolver {
  require(opaqueRef: string): WorkerResolvedMedia;
  describe(opaqueRef: string): { readonly opaqueRef: string };
}

export class StaticWorkerMediaResolver implements WorkerMediaResolver {
  readonly #refs = new Map<string, string>();

  constructor(entries: Readonly<Record<string, string>>) {
    for (const [opaqueRef, workerPrivateValue] of Object.entries(entries)) {
      this.#refs.set(opaqueRef, workerPrivateValue);
    }
  }

  require(opaqueRef: string): WorkerResolvedMedia {
    const value = this.#refs.get(opaqueRef);
    if (value === undefined) throw new Error(`required Worker media is unavailable: ${opaqueRef}`);
    if (opaqueRef.startsWith('html-scene:')) return { kind: 'html-scene', packageId: value };
    if (!existsSync(value)) throw new Error(`required Worker media is unavailable: ${opaqueRef}`);
    return { kind: 'file', path: value };
  }

  describe(opaqueRef: string): { readonly opaqueRef: string } {
    if (!this.#refs.has(opaqueRef))
      throw new Error(`required Worker media is unavailable: ${opaqueRef}`);
    return { opaqueRef };
  }
}

export function mediaResolverFromAssetSourceRegistry(source: {
  readonly resolve: (assetId: string) => string | undefined;
}): WorkerMediaResolver {
  return {
    require(opaqueRef) {
      if (opaqueRef.startsWith('html-scene:')) {
        return { kind: 'html-scene', packageId: opaqueRef.slice('html-scene:'.length) };
      }
      if (!opaqueRef.startsWith('asset:')) {
        throw new Error(`required Worker media is unavailable: ${opaqueRef}`);
      }
      const assetId = opaqueRef.slice('asset:'.length);
      const path = source.resolve(assetId);
      if (path === undefined || !existsSync(path)) {
        throw new Error(`required Worker media is unavailable: ${opaqueRef}`);
      }
      return { kind: 'file', path };
    },
    describe(opaqueRef) {
      this.require(opaqueRef);
      return { opaqueRef };
    },
  };
}
