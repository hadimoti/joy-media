import { createPublicKey, verify as verifySignature } from 'node:crypto';

export interface ReleaseManifestPayload {
  readonly channel: 'stable' | 'beta';
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly minSupportedVersion?: string;
}

export interface SignedReleaseManifest {
  readonly payload: ReleaseManifestPayload;
  readonly signature: string;
}

export type AutoUpdateBlockReason =
  | 'subscription-required'
  | 'release-key-unconfigured'
  | 'manifest-invalid'
  | 'signature-invalid'
  | 'download-url-invalid'
  | 'not-newer';

export type AutoUpdateDecision =
  | { readonly status: 'blocked'; readonly reason: AutoUpdateBlockReason }
  | { readonly status: 'current'; readonly reason: 'not-newer' }
  | {
      readonly status: 'update';
      readonly manifest: SignedReleaseManifest;
      readonly forced: boolean;
      /** False by default; the caller still owns the actual download operation. */
      readonly autoDownload: boolean;
    };

const DEFAULT_RELEASE_HOSTS = ['joyst.ir', 'www.joyst.ir'] as const;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Pure, network-free release gate for the desktop shell. It does not fetch or install anything:
 * the caller must first obtain a manifest, then pass it here before considering a download.
 * Missing keys, inactive subscriptions, invalid URLs, malformed hashes, bad signatures, and
 * downgrades all fail closed.
 */
export function evaluateAutoUpdate(options: {
  readonly manifest: SignedReleaseManifest;
  readonly currentVersion: string;
  readonly subscriptionActive: boolean;
  readonly pinnedPublicKeyPem?: string;
  readonly allowedHosts?: readonly string[];
  readonly allowAutomaticDownload?: boolean;
}): AutoUpdateDecision {
  if (!options.subscriptionActive) {
    return { status: 'blocked', reason: 'subscription-required' };
  }
  if (options.pinnedPublicKeyPem === undefined || options.pinnedPublicKeyPem.trim() === '') {
    return { status: 'blocked', reason: 'release-key-unconfigured' };
  }

  const payload = options.manifest.payload;
  const current = parseVersion(options.currentVersion);
  const next = parseVersion(payload.version);
  if (
    current === undefined ||
    next === undefined ||
    !isSignedManifestShape(options.manifest) ||
    !isValidSha256(payload.sha256) ||
    !isAllowedDownloadUrl(payload.downloadUrl, options.allowedHosts ?? DEFAULT_RELEASE_HOSTS) ||
    (payload.minSupportedVersion !== undefined &&
      parseVersion(payload.minSupportedVersion) === undefined)
  ) {
    return { status: 'blocked', reason: 'manifest-invalid' };
  }
  if (!isAllowedDownloadUrl(payload.downloadUrl, options.allowedHosts ?? DEFAULT_RELEASE_HOSTS)) {
    return { status: 'blocked', reason: 'download-url-invalid' };
  }
  if (!verifyManifestSignature(options.manifest, options.pinnedPublicKeyPem)) {
    return { status: 'blocked', reason: 'signature-invalid' };
  }

  const comparison = compareVersions(next, current);
  if (comparison <= 0) {
    return { status: 'current', reason: 'not-newer' };
  }
  const minimum =
    payload.minSupportedVersion === undefined
      ? undefined
      : parseVersion(payload.minSupportedVersion);
  return {
    status: 'update',
    manifest: options.manifest,
    forced: minimum !== undefined && compareVersions(current, minimum) < 0,
    autoDownload: options.allowAutomaticDownload === true,
  };
}

function isSignedManifestShape(value: SignedReleaseManifest): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.signature === 'string' &&
    value.signature.length > 0 &&
    (value.payload.channel === 'stable' || value.payload.channel === 'beta') &&
    typeof value.payload.downloadUrl === 'string' &&
    typeof value.payload.version === 'string'
  );
}

function isValidSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function isAllowedDownloadUrl(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      hosts.some((host) => url.hostname.toLowerCase() === host.toLowerCase())
    );
  } catch {
    return false;
  }
}

function verifyManifestSignature(manifest: SignedReleaseManifest, publicKeyPem: string): boolean {
  try {
    return verifySignature(
      null,
      canonicalize(manifest.payload),
      createPublicKey(publicKeyPem),
      Buffer.from(manifest.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function canonicalize(payload: ReleaseManifestPayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      channel: payload.channel,
      version: payload.version,
      downloadUrl: payload.downloadUrl,
      sha256: payload.sha256,
      ...(payload.minSupportedVersion === undefined
        ? {}
        : { minSupportedVersion: payload.minSupportedVersion }),
    }),
    'utf8',
  );
}

type ParsedVersion = readonly [
  major: number,
  minor: number,
  patch: number,
  prerelease: string | undefined,
];

function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left !== right) return left > right ? 1 : -1;
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === undefined) return 1;
  if (b[3] === undefined) return -1;
  return a[3] > b[3] ? 1 : a[3] < b[3] ? -1 : 0;
}
