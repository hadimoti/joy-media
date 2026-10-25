import {
  evaluateReleaseUpdate,
  fetchLatestSignedManifest,
  releasePageUrl,
} from '@joy-media/release-trust';
import type { FetchedReleaseManifest, ReleaseUpdateBlockReason } from '@joy-media/release-trust';

/**
 * What the renderer receives from an update check. An available update is a notice that links to the release page:
 * this app never downloads or installs a release in v1.0.3. A failed fetch is a block, never an update.
 */
export type UpdateCheckResult =
  | {
      readonly status: 'blocked';
      readonly reason: ReleaseUpdateBlockReason | 'network-unavailable';
    }
  | { readonly status: 'current'; readonly reason: 'not-newer'; readonly latestVersion: string }
  | {
      readonly status: 'update';
      readonly latestVersion: string;
      readonly forced: boolean;
      readonly releaseUrl: string;
    };

/**
 * Checks the latest GitHub release for a newer signed version. It fetches the manifest and its signature, verifies
 * them against the keys this build trusts and the app's own version, and reports the outcome. Nothing calls this on
 * its own: the user asks for the check. The check has no subscription requirement.
 */
export async function checkForReleaseUpdate(options: {
  readonly currentVersion: string;
  readonly publicKeysPem: readonly string[];
  readonly fetch: typeof fetch;
}): Promise<UpdateCheckResult> {
  // With no trusted key nothing can verify, so no request is made at all.
  if (options.publicKeysPem.length === 0)
    return { status: 'blocked', reason: 'release-key-unconfigured' };

  let fetched: FetchedReleaseManifest;
  try {
    fetched = await fetchLatestSignedManifest({ fetch: options.fetch });
  } catch {
    return { status: 'blocked', reason: 'network-unavailable' };
  }
  const decision = evaluateReleaseUpdate({
    manifestBytes: fetched.manifestBytes,
    signature: fetched.signature,
    installedVersion: options.currentVersion,
    publicKeysPem: options.publicKeysPem,
  });
  if (decision.status === 'update') {
    return {
      status: 'update',
      latestVersion: decision.manifest.version,
      forced: decision.forced,
      releaseUrl: releasePageUrl(decision.manifest.version),
    };
  }
  return decision;
}
