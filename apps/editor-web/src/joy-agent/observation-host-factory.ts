import type { AssetRecordV1 } from '@joy-media/project-schema';
import type {
  JoyAgentObservationAssetMetadata,
  JoyAgentObservationCurrentAuthority,
  JoyAgentObservationHostBridge,
} from './observation-tool-adapter.js';

/**
 * Main-thread factory boundary. It receives only a run-bound authority reader;
 * the App remains responsible for its resolver, decoder worker, caches and
 * canonical project session. Nothing in this interface is transferable to the
 * model Worker.
 */
export interface JoyAgentObservationAdapterFactory {
  create(input: {
    readonly projectId: string;
    readonly revision: string;
    readonly currentAuthority: () => JoyAgentObservationCurrentAuthority | undefined;
  }): JoyAgentObservationHostBridge | undefined;
}

/** The source decoder currently observes its one selected primary video track. */
export const JOY_PRIMARY_OBSERVATION_STREAM_ID = 'video-0';
export const JOY_SOURCE_OBSERVATION_ANALYSIS_VERSION = 'joy-source-observation-v1';

const SHA_256 = /^[a-f0-9]{64}$/i;

/**
 * Convert only complete, project-authored video descriptors into source
 * observation facts. AssetRecordV1 does not carry a container stream index or
 * transform matrix, so this deliberately returns `undefined` instead of
 * inventing a duration, geometry, proxy status, or transcript linkage.
 *
 * `streamCount: 1` means exactly one observable primary-track selection in
 * JOY's current source decoder, not a claim that the container has one stream.
 */
export function observationMetadataForAsset(
  asset: AssetRecordV1 | undefined,
): JoyAgentObservationAssetMetadata | undefined {
  const descriptor = asset?.descriptor;
  const durationUs = descriptor?.durationUs;
  const width = descriptor?.width;
  const height = descriptor?.height;
  if (
    asset === undefined ||
    asset.kind !== 'video' ||
    typeof asset.sha256 !== 'string' ||
    !SHA_256.test(asset.sha256) ||
    typeof durationUs !== 'number' ||
    !Number.isSafeInteger(durationUs) ||
    durationUs < 1 ||
    typeof width !== 'number' ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(height) ||
    height < 1
  )
    return undefined;

  return Object.freeze({
    assetId: asset.id,
    assetDigest: asset.sha256.toLowerCase(),
    kind: 'video',
    durationUs,
    streamCount: 1,
    streamId: JOY_PRIMARY_OBSERVATION_STREAM_ID,
    sourceVariant: Object.freeze({
      crop: Object.freeze({
        x: 0,
        y: 0,
        width,
        height,
      }),
      rotationDeg: 0,
      representation: 'original',
      analysisVersion: JOY_SOURCE_OBSERVATION_ANALYSIS_VERSION,
    }),
  });
}
