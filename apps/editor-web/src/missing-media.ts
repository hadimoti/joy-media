import type { AssetRecordV1, SpikeProject } from '@joy-media/project-schema';
import { verifyReplacementMedia, type RelinkCache } from './media-relink.js';
import { flattenRootTimelineVideoClips } from './timeline-nested-playback.js';

/** A project asset whose original is not in this browser profile's cache. */
export interface MissingMediaEntry {
  readonly assetId: string;
  readonly record: AssetRecordV1;
}

/** A candidate file matched to a missing asset by SHA-256 and byte length. */
export interface MediaFileMatch {
  readonly assetId: string;
  readonly file: Blob;
  readonly fileName: string;
}

export interface BatchMatchResult {
  readonly matches: readonly MediaFileMatch[];
  /** Files whose hash and size match no missing asset. */
  readonly unmatchedFileNames: readonly string[];
  /** Missing assets that no chosen file matched. */
  readonly unresolvedAssetIds: readonly string[];
}

/**
 * Asset kinds that are not files, so they can never be missing media (T-R01). A text,
 * caption, motion, effect, filter, adjustment layer, overlay or HTML scene is recorded as
 * an `other` asset with no original; a LUT is a grade, not a media original.
 */
export const NON_FILE_ASSET_KINDS: ReadonlySet<AssetRecordV1['kind']> = new Set(['lut', 'other']);

/**
 * Derives the project's missing media from its asset records and the local
 * original cache. The control-plane catalog is deliberately not consulted: a
 * package-imported asset exists only in the project and this profile's cache.
 * Only the asset's kind decides which records are skipped; saved projects are not changed.
 */
export async function deriveMissingMedia(
  assets: Readonly<Record<string, AssetRecordV1>>,
  cache: RelinkCache,
): Promise<readonly MissingMediaEntry[]> {
  const missing: MissingMediaEntry[] = [];
  for (const [assetId, record] of Object.entries(assets)) {
    if (NON_FILE_ASSET_KINDS.has(record.kind)) continue;
    if ((await cache.get(assetId)) === undefined) missing.push({ assetId, record });
  }
  return missing;
}

/**
 * The asset ids of a missing list. A timeline clip is marked missing exactly when its asset id is in
 * this set (T-R03), so only the clips that use the missing file are marked.
 */
export function missingAssetIdSet(missing: readonly MissingMediaEntry[]): ReadonlySet<string> {
  return new Set(missing.map((entry) => entry.assetId));
}

/**
 * The display name of the missing file that the Program Monitor cannot draw at `timeUs`, or
 * undefined when every video clip playing then has its file. The monitor shows a "Media offline"
 * frame with this name instead of a black or stale picture (T-R03).
 */
export function missingClipNameAt(
  project: SpikeProject,
  missingAssetIds: ReadonlySet<string>,
  timeUs: number,
  nameOf: (assetId: string) => string,
): string | undefined {
  if (missingAssetIds.size === 0) return undefined;
  const playing = flattenRootTimelineVideoClips(project).filter(
    (clip) => timeUs >= clip.startUs && timeUs < clip.startUs + clip.durationUs,
  );
  const missingClip = playing.find((clip) => missingAssetIds.has(clip.assetId));
  return missingClip === undefined ? undefined : nameOf(missingClip.assetId);
}

/**
 * Matches chosen files to missing assets by content. A file is assigned to the
 * first missing asset whose recorded hash and size it satisfies, and each asset
 * takes at most one file. Nothing is written here.
 */
export async function matchReplacementFiles(
  missing: readonly MissingMediaEntry[],
  files: readonly { readonly file: Blob; readonly fileName: string }[],
): Promise<BatchMatchResult> {
  const remaining = [...missing];
  const matches: MediaFileMatch[] = [];
  const unmatchedFileNames: string[] = [];
  for (const candidate of files) {
    let matchedIndex = -1;
    for (let index = 0; index < remaining.length; index++) {
      const verdict = await verifyReplacementMedia(remaining[index]!.record, candidate.file);
      if (verdict.ok) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex === -1) {
      unmatchedFileNames.push(candidate.fileName);
      continue;
    }
    const [entry] = remaining.splice(matchedIndex, 1);
    matches.push({ assetId: entry!.assetId, file: candidate.file, fileName: candidate.fileName });
  }
  return {
    matches,
    unmatchedFileNames,
    unresolvedAssetIds: remaining.map((entry) => entry.assetId),
  };
}
