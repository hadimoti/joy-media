import type { AssetRecordV1, SpikeProject } from '@joy-media/project-schema';
import type { CommandTransaction, SpikeCommand } from '@joy-media/commands';

/** Lower-case hex SHA-256 of a blob's bytes. */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds the record for a replacement asset. It carries its own checksum and
 * length, so it verifies on its own. The original record is never modified.
 */
export async function buildReplacementAsset(
  original: AssetRecordV1,
  replacementId: string,
  file: Blob,
): Promise<AssetRecordV1> {
  return {
    id: replacementId,
    kind: original.kind,
    displayName: `${original.displayName} (replacement)`,
    sha256: await sha256OfBlob(file),
    bytes: file.size,
    descriptor: {
      ...(original.descriptor ?? {}),
      mimeType: file.type || original.descriptor?.mimeType || 'application/octet-stream',
    },
  };
}

/**
 * Every video clip, in every composition and track, that references `fromAssetId`,
 * repointed at `toAssetId`. The transaction is one undo step.
 */
export function repointClipsTransaction(
  project: SpikeProject,
  fromAssetId: string,
  toAssetId: string,
  label: string,
): CommandTransaction {
  const commands: SpikeCommand[] = [];
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'video' || clip.assetId !== fromAssetId) continue;
        commands.push({
          type: 'timeline.setClipAsset',
          payload: {
            compositionId: composition.id,
            trackId: track.id,
            clipId: clip.id,
            assetId: toAssetId,
          },
        });
      }
    }
  }
  return { label, commands };
}
