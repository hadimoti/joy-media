export type ReleaseChannel = 'stable' | 'beta';

export interface ReleaseManifestFile {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * The signed release manifest (`release-manifest.json`). Every file of a release is listed with its size and SHA-256,
 * and the whole document is covered by one detached signature over its exact bytes.
 */
export interface ReleaseManifest {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly issuedAt: string;
  readonly minSupportedVersion?: string;
  readonly files: readonly ReleaseManifestFile[];
}

export class ReleaseManifestError extends Error {}

const MAX_FILES = 256;
const MAX_FILE_BYTES = 4 * 1024 ** 3;
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'channel',
  'version',
  'issuedAt',
  'minSupportedVersion',
  'files',
]);
const FILE_KEYS: ReadonlySet<string> = new Set(['name', 'size', 'sha256']);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * Parses the exact bytes of a manifest. Call this only after the signature over those bytes has verified. The schema
 * is strict: an unknown key, a path-like file name, a duplicate name or a malformed hash refuses the whole manifest.
 */
export function parseReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseManifestError('the manifest is not UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReleaseManifestError('the manifest is not JSON');
  }
  if (!isRecord(value)) throw new ReleaseManifestError('the manifest must be a JSON object');
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, 'the manifest');

  const channel = value['channel'];
  if (channel !== 'stable' && channel !== 'beta')
    throw new ReleaseManifestError('the manifest channel must be stable or beta');
  const version = requireSemver(value['version'], 'version');
  const issuedAt = value['issuedAt'];
  if (typeof issuedAt !== 'string' || !ISO_UTC.test(issuedAt) || Number.isNaN(Date.parse(issuedAt)))
    throw new ReleaseManifestError('the manifest issuedAt must be a UTC time');
  const minSupportedVersion =
    value['minSupportedVersion'] === undefined
      ? undefined
      : requireSemver(value['minSupportedVersion'], 'minSupportedVersion');
  const files = requireFiles(value['files']);

  return {
    channel,
    version,
    issuedAt,
    files,
    ...(minSupportedVersion === undefined ? {} : { minSupportedVersion }),
  };
}

function requireSemver(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SEMVER.test(value))
    throw new ReleaseManifestError(`the manifest ${label} must be a semantic version`);
  return value;
}

function requireFiles(value: unknown): ReleaseManifestFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES)
    throw new ReleaseManifestError(`the manifest must list 1 to ${MAX_FILES} files`);
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw new ReleaseManifestError('each manifest file must be an object');
    rejectUnknownKeys(entry, FILE_KEYS, 'a manifest file entry');
    const name = entry['name'];
    if (typeof name !== 'string' || !FILE_NAME.test(name))
      throw new ReleaseManifestError('a manifest file name must be a plain file name');
    if (names.has(name)) throw new ReleaseManifestError('manifest file names must be unique');
    names.add(name);
    const size = entry['size'];
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_FILE_BYTES
    )
      throw new ReleaseManifestError('a manifest file size is out of range');
    const sha256 = entry['sha256'];
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256))
      throw new ReleaseManifestError('a manifest file sha256 must be 64 lowercase hex characters');
    return { name, size, sha256 };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ReleaseManifestError(`${label} has an unknown key`);
  }
}
