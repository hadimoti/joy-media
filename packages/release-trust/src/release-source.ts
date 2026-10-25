/** The public repository that publishes the releases, and the two signed files attached to its latest release. */
export const RELEASE_REPOSITORY = 'hadimoti/joy-media';
export const RELEASE_MANIFEST_FILE = 'release-manifest.json';
export const RELEASE_SIGNATURE_FILE = 'release-manifest.json.sig';

/**
 * Hosts a release download may come from. The host is not the root of trust: the signed hash is. The allowlist keeps
 * a redirect from leaving GitHub's release hosts, and a file from any other host is refused before it is read.
 */
export const RELEASE_HOSTS: readonly string[] = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 512;
const DEFAULT_TIMEOUT_MS = 15_000;

export class ReleaseSourceError extends Error {}

export interface FetchedReleaseManifest {
  readonly manifestBytes: Uint8Array;
  readonly signature: string;
}

export function latestReleaseAssetUrl(fileName: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/${fileName}`;
}

/** The release page a user is linked to when an update is available. The app never downloads from it. */
export function releasePageUrl(version: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
}

export function isAllowedReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      RELEASE_HOSTS.includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * Fetches the manifest and its signature from the latest release. Each response is size-capped, must come from an
 * allowlisted host after redirects, and must succeed. The bytes are returned unchanged, so the signature is checked
 * over exactly what was received.
 */
export async function fetchLatestSignedManifest(options: {
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<FetchedReleaseManifest> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const manifestBytes = await fetchCapped(
    options.fetch,
    latestReleaseAssetUrl(RELEASE_MANIFEST_FILE),
    MAX_MANIFEST_BYTES,
    timeoutMs,
  );
  const signatureBytes = await fetchCapped(
    options.fetch,
    latestReleaseAssetUrl(RELEASE_SIGNATURE_FILE),
    MAX_SIGNATURE_BYTES,
    timeoutMs,
  );
  let signature: string;
  try {
    signature = new TextDecoder('utf-8', { fatal: true }).decode(signatureBytes);
  } catch {
    throw new ReleaseSourceError('the release signature is not text');
  }
  return { manifestBytes, signature };
}

async function fetchCapped(
  fetchFn: typeof fetch,
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/octet-stream' },
    });
  } catch {
    throw new ReleaseSourceError('the release files could not be fetched');
  }
  if (!response.ok) throw new ReleaseSourceError(`the release server answered ${response.status}`);
  if (!isAllowedReleaseUrl(response.url))
    throw new ReleaseSourceError('the release files came from a host that is not allowed');
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes)
    throw new ReleaseSourceError('a release file is larger than the allowed size');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new ReleaseSourceError('a release file is larger than the allowed size');
  return bytes;
}
