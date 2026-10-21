import type { AssetRecordV1 } from '@joy-media/project-schema';
import { verifyReplacementMedia, type RelinkCache } from './media-relink.js';

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
 * Derives the project's missing media from its asset records and the local
 * original cache. The control-plane catalog is deliberately not consulted: a
 * package-imported asset exists only in the project and this profile's cache.
 */
export async function deriveMissingMedia(
  assets: Readonly<Record<string, AssetRecordV1>>,
  cache: RelinkCache,
): Promise<readonly MissingMediaEntry[]> {
  const missing: MissingMediaEntry[] = [];
  for (const [assetId, record] of Object.entries(assets)) {
    if (record.kind === 'lut') continue;
    if ((await cache.get(assetId)) === undefined) missing.push({ assetId, record });
  }
  return missing;
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
