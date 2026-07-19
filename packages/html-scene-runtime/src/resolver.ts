/**
 * Asset and font resolution (§39-69, §20.4). Scenes reference assets and fonts
 * by logical id; JOY binds those ids to concrete, self-contained handles (data:
 * or blob: URLs) before render. Unresolved references are a hard error — a scene
 * must never silently render empty content when an asset is missing (§20.4).
 */

export class SceneAssetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SceneAssetError';
    this.code = code;
  }
}

export interface JoySceneAssetResolver {
  has(assetId: string): boolean;
  /** Resolves a logical asset id to a self-contained handle, or throws. */
  resolve(assetId: string): string;
}

export interface JoySceneFontResolver {
  has(family: string): boolean;
  /** Resolves a font family to a self-contained handle, or throws. */
  resolve(family: string): string;
}

export interface SceneResolvers {
  readonly assets: JoySceneAssetResolver;
  readonly fonts: JoySceneFontResolver;
}

function makeResolver(
  kind: 'asset' | 'font',
  table: Readonly<Record<string, string>>,
): JoySceneAssetResolver & JoySceneFontResolver {
  return {
    has: (key: string) => Object.prototype.hasOwnProperty.call(table, key),
    resolve: (key: string) => {
      const handle = table[key];
      if (handle === undefined)
        throw new SceneAssetError(
          kind === 'asset' ? 'SCENE_ASSET_UNRESOLVED' : 'SCENE_FONT_UNRESOLVED',
          `unresolved ${kind} "${key}"`,
        );
      return handle;
    },
  };
}

/**
 * Builds resolvers from id→handle tables. Handles are expected to be
 * self-contained (data:/blob:) so a compiled scene has no external dependencies.
 */
export function createManifestResolver(
  assets: Readonly<Record<string, string>> = {},
  fonts: Readonly<Record<string, string>> = {},
): SceneResolvers {
  return { assets: makeResolver('asset', assets), fonts: makeResolver('font', fonts) };
}

/** Collects the ids a resolver cannot resolve — the export-time preflight check. */
export function findUnresolved(
  resolver: JoySceneAssetResolver | JoySceneFontResolver,
  ids: readonly string[],
): readonly string[] {
  return ids.filter((id) => !resolver.has(id));
}
