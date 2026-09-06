import type {
  AssetDescriptorV1,
  AssetRecordV1,
  JoyProjectV1,
  TimelineTrackFamily,
} from '@joy-media/project-schema';

/**
 * The narrow, host-owned asset shape admitted to a Joy Code timeline compiler.
 *
 * Proposal payloads carry only an opaque asset ID; they never choose a media
 * family. The compiler resolves that ID through this descriptor derived from
 * the canonical project document immediately before it builds a command.
 */
export interface JoyCodeAssetDescriptor {
  readonly id: string;
  readonly kind: AssetRecordV1['kind'];
  readonly descriptor?: AssetDescriptorV1;
}

export type JoyCodeInsertableAssetKind = 'audio' | 'image' | 'video';

export type JoyCodeAssetResolution =
  | {
      readonly ok: true;
      readonly asset: JoyCodeAssetDescriptor & { readonly kind: JoyCodeInsertableAssetKind };
      readonly trackFamily: TimelineTrackFamily;
    }
  | {
      readonly ok: false;
      readonly code: 'JOY_CODE_TIMELINE_ASSET_UNAVAILABLE' | 'JOY_CODE_TIMELINE_ASSET_UNSUPPORTED';
      readonly message: string;
    };

/** Build immutable compiler input from the canonical document, never UI IDs. */
export function joyCodeAssetDescriptorsFromProject(
  project: Pick<JoyProjectV1, 'assets'>,
): readonly JoyCodeAssetDescriptor[] {
  return Object.freeze(
    Object.entries(project.assets)
      .filter(([id, asset]) => id.length > 0 && asset.id === id)
      .map(([id, asset]) =>
        Object.freeze({
          id,
          kind: asset.kind,
          ...(asset.descriptor === undefined ? {} : { descriptor: asset.descriptor }),
        }),
      ),
  );
}

/**
 * Resolve the only media kinds the current timeline adapter can represent.
 * LUT and other assets are deliberately rejected instead of being coerced
 * into visual clips.
 */
export function resolveJoyCodeInsertableAsset(
  assetId: string,
  assets: readonly JoyCodeAssetDescriptor[],
): JoyCodeAssetResolution {
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (asset === undefined)
    return {
      ok: false,
      code: 'JOY_CODE_TIMELINE_ASSET_UNAVAILABLE',
      message: `asset "${assetId}" is not registered with a trusted descriptor`,
    };
  switch (asset.kind) {
    case 'audio':
      return { ok: true, asset: { ...asset, kind: 'audio' }, trackFamily: 'audio' };
    case 'image':
      return { ok: true, asset: { ...asset, kind: 'image' }, trackFamily: 'visual' };
    case 'video':
      return { ok: true, asset: { ...asset, kind: 'video' }, trackFamily: 'visual' };
    case 'lut':
    case 'other':
      return {
        ok: false,
        code: 'JOY_CODE_TIMELINE_ASSET_UNSUPPORTED',
        message: `asset "${assetId}" has unsupported media kind "${asset.kind}"`,
      };
  }
}
