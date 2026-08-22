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
      if (opaqueRef.startsWith('motion-scene:')) {
        // Motion Studio scenes are published as renderable media before a
        // Worker can consume them. The source registry owns the private path;
        // do not silently turn an unresolved scene into a placeholder frame.
        const sceneId = opaqueRef.slice('motion-scene:'.length);
        const path = source.resolve(opaqueRef) ?? source.resolve(sceneId);
        if (path === undefined || !existsSync(path)) {
          throw new Error(
            `required Worker motion scene media is unavailable: ${opaqueRef}; publish or render the scene first`,
          );
        }
        return { kind: 'file', path };
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
