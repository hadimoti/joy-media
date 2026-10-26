import { parseReleaseManifest, ReleaseManifestError } from './manifest.js';
import type { ReleaseChannel, ReleaseManifest } from './manifest.js';
import { parseSignatureText, verifyReleaseManifestSignature } from './signature.js';

export type ReleaseUpdateBlockReason =
  | 'release-key-unconfigured'
  | 'installed-version-invalid'
  | 'signature-invalid'
  | 'manifest-invalid'
  | 'channel-mismatch';

export type ReleaseUpdateDecision =
  | { readonly status: 'blocked'; readonly reason: ReleaseUpdateBlockReason }
  | { readonly status: 'current'; readonly reason: 'not-newer'; readonly latestVersion: string }
  | { readonly status: 'update'; readonly manifest: ReleaseManifest; readonly forced: boolean };

const SEMVER_PARTS = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

/**
 * Decides what a fetched release means for the installed app. It makes no network call and installs nothing. The
 * order is fixed so that each refusal names its real cause: keys first, then the signature over the raw bytes, then
 * the schema, then the channel, and only then the version. An older but validly signed manifest is "not newer", so
 * a downgrade is never offered. A failed check is always a block, never an update.
 */
export function evaluateReleaseUpdate(options: {
  readonly manifestBytes: Uint8Array;
  readonly signature: string;
  readonly installedVersion: string;
  readonly installedChannel?: ReleaseChannel;
  readonly publicKeysPem: readonly string[];
}): ReleaseUpdateDecision {
  if (options.publicKeysPem.length === 0)
    return { status: 'blocked', reason: 'release-key-unconfigured' };
  if (!SEMVER_PARTS.test(options.installedVersion))
    return { status: 'blocked', reason: 'installed-version-invalid' };
  const signatureValid = verifyReleaseManifestSignature({
    manifest: options.manifestBytes,
    signature: parseSignatureText(options.signature),
    publicKeysPem: options.publicKeysPem,
  });
  if (!signatureValid) return { status: 'blocked', reason: 'signature-invalid' };

  let manifest: ReleaseManifest;
  try {
    manifest = parseReleaseManifest(options.manifestBytes);
  } catch (error) {
    if (error instanceof ReleaseManifestError)
      return { status: 'blocked', reason: 'manifest-invalid' };
    throw error;
  }
  if (manifest.channel !== (options.installedChannel ?? 'stable'))
    return { status: 'blocked', reason: 'channel-mismatch' };
  if (compareVersions(manifest.version, options.installedVersion) <= 0)
    return { status: 'current', reason: 'not-newer', latestVersion: manifest.version };

  const forced =
    manifest.minSupportedVersion !== undefined &&
    compareVersions(options.installedVersion, manifest.minSupportedVersion) < 0;
  return { status: 'update', manifest, forced };
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. A release outranks its prereleases. */
export function compareVersions(a: string, b: string): number {
  const left = SEMVER_PARTS.exec(a);
  const right = SEMVER_PARTS.exec(b);
  if (left === null || right === null) throw new RangeError('compareVersions needs valid versions');
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(left[index]) - Number(right[index]);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  const leftPre = left[4];
  const rightPre = right[4];
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  return comparePrerelease(leftPre, rightPre);
}

/**
 * Orders two prerelease strings by SemVer 11.4: dot-separated identifiers compare one by one. Numeric identifiers
 * compare as numbers and sort below alphanumeric ones. When every shared identifier is equal, the longer list is newer.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const delta = comparePrereleaseIdentifier(left[index] ?? '', right[index] ?? '');
    if (delta !== 0) return delta;
  }
  if (left.length === right.length) return 0;
  return left.length > right.length ? 1 : -1;
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/u.test(a);
  const bNumeric = /^\d+$/u.test(b);
  if (aNumeric && bNumeric) {
    // SemVer numeric identifiers have no leading zeros, so the longer one is the larger number.
    if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  } else if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1;
  }
  return a === b ? 0 : a > b ? 1 : -1;
}
