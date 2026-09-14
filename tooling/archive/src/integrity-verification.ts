import type { ArchiveManifest } from './manifest.js';

/**
 * No-data-loss verification (JOY Media desktop migration, wave 6). Run this after export,
 * against an independently-obtained project count from the live data source (not from the
 * archive itself — comparing a manifest to its own entries only proves internal consistency,
 * never completeness) to catch a source query that silently dropped rows.
 */

export interface NoDataLossCheck {
  readonly ok: boolean;
  readonly expectedProjectCount: number;
  readonly manifestProjectCount: number;
  readonly issues: readonly string[];
}

const PROJECT_ENTRY_PATTERN = /^projects\/[^/]+\.json$/;

export function verifyNoDataLoss(
  manifest: ArchiveManifest,
  expectedProjectCount: number,
): NoDataLossCheck {
  const manifestProjectCount = manifest.entries.filter((entry) =>
    PROJECT_ENTRY_PATTERN.test(entry.name),
  ).length;
  const issues: string[] = [];
  if (manifestProjectCount !== expectedProjectCount) {
    issues.push(
      `expected ${expectedProjectCount} project(s) from the live source, archive contains ${manifestProjectCount}`,
    );
  }
  if (manifest.entryCount !== manifest.entries.length) {
    // Defensive: this should be structurally impossible from buildManifest, but a
    // hand-constructed or corrupted manifest object could disagree with itself.
    issues.push(
      `manifest.entryCount (${manifest.entryCount}) does not match manifest.entries.length (${manifest.entries.length})`,
    );
  }
  return { ok: issues.length === 0, expectedProjectCount, manifestProjectCount, issues };
}
