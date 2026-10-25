import type { AudioPresenceResult } from './media-audio-presence.js';
import { probeDesktopAudioPresence, stageDesktopMedia } from './desktop-client.js';

/**
 * Decides which video sources contribute no sound to an export.
 *
 * Only a source that is proven silent is dropped from the audio mix. `present` and `unknown` both
 * keep the source in the mix, so a file whose audio cannot be checked is still decoded, and a real
 * decode failure is still reported. Silence is never assumed.
 */

export interface AudioAssetInfo {
  readonly kind: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly displayName?: string;
}

export interface SilentVideoProbe {
  /** Bytes of a project asset, or undefined when they cannot be read. */
  readonly loadBlob: (assetId: string) => Promise<Blob | undefined>;
  /** Desktop check (stage then ffprobe). Undefined outside the desktop host. */
  readonly desktop?: (asset: AudioAssetInfo, blob: Blob) => Promise<AudioPresenceResult>;
  /** Browser check from container metadata. */
  readonly inspect: (blob: Blob, fileName: string) => Promise<AudioPresenceResult>;
}

/** Returns the ids of video assets proven to have no audio stream. */
export async function findSilentVideoAssetIds(
  assetIds: readonly string[],
  assets: Readonly<Record<string, AudioAssetInfo | undefined>>,
  probe: SilentVideoProbe,
  onStatus?: (message: string) => void,
): Promise<ReadonlySet<string>> {
  const silent = new Set<string>();
  for (const assetId of new Set(assetIds)) {
    const asset = assets[assetId];
    if (asset?.kind !== 'video') continue;
    onStatus?.(`Checking audio in ${asset.displayName ?? assetId}…`);
    const blob = await probe.loadBlob(assetId);
    // An unreadable source cannot be proven silent, so it stays in the mix and fails visibly there.
    if (blob === undefined) continue;
    const presence = await presenceOf(asset, blob, probe);
    if (presence.status === 'absent') silent.add(assetId);
  }
  return silent;
}

/**
 * Desktop check: makes sure the desktop host holds this original (reusing a verified copy when it
 * has one), then asks ffprobe for its audio streams. Requires the asset's recorded hash and size.
 */
export async function desktopAudioPresenceFor(
  asset: AudioAssetInfo,
  blob: Blob,
): Promise<AudioPresenceResult> {
  if (asset.sha256 === undefined || asset.bytes === undefined)
    return { status: 'unknown', reason: 'the asset has no recorded hash' };
  const source = {
    sha256: asset.sha256,
    bytes: asset.bytes,
    displayName: asset.displayName ?? 'media',
  };
  await stageDesktopMedia(source, blob);
  return probeDesktopAudioPresence(source);
}

async function presenceOf(
  asset: AudioAssetInfo,
  blob: Blob,
  probe: SilentVideoProbe,
): Promise<AudioPresenceResult> {
  if (probe.desktop !== undefined) {
    try {
      const desktop = await probe.desktop(asset, blob);
      if (desktop.status !== 'unknown') return desktop;
    } catch {
      /* fall back to the browser check below */
    }
  }
  try {
    return await probe.inspect(blob, asset.displayName ?? '');
  } catch (error) {
    return {
      status: 'unknown',
      reason: error instanceof Error ? error.message : 'audio check failed',
    };
  }
}
