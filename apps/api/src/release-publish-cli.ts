import type { ReleaseManifestPayload } from './release-signing.js';
import type { ReleasePublishRequest, ReleasePublisher } from './release-publish.js';
import type { ReleaseRecord } from './release-metadata-service.js';

/**
 * The direct-call release publish entrypoint `release-metadata-service.ts` and
 * `release-publish.ts`'s module docs promise ("not reachable from any route ... the wave 7
 * publish pipeline calls it directly with owner/Codex approval"). Before this module existed,
 * `createReleasePublisher` (release-publish.ts) had no caller anywhere in the repo outside its
 * own unit test — this closes that gap without adding an HTTP route, matching the locked
 * decision that publishing stays operator-triggered, never publicly reachable.
 *
 * `apps/api/src/scripts/publish-release.ts` is the thin, untested wiring shell (real Postgres
 * pool, real credential-file read, real `process.argv`/`console`) that calls `runReleasePublish`
 * below with real dependencies — same "pure logic here, unchecked wiring at the edge" split as
 * `server.ts` itself. Nothing in this repository invokes that script; it exists for Codex/the
 * owner to run once a real database and the `joy-media-release-signing-key` credential are
 * provisioned (see release-signing.ts's module doc).
 */

export class ReleasePublishCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReleasePublishCliError';
  }
}

export interface ParsedReleasePublishInput {
  readonly id: string;
  readonly payload: ReleaseManifestPayload;
}

/** Validates an untrusted, deserialized JSON value into a well-shaped publish request before
 * anything is signed or persisted. Fails closed on any missing/malformed field rather than
 * forwarding a partial payload to the signer. */
export function parseReleasePublishInput(raw: unknown): ParsedReleasePublishInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new ReleasePublishCliError(
      'RELEASE_INPUT_INVALID',
      'release payload must be a JSON object',
    );
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate['id'] !== 'string' || candidate['id'].length === 0) {
    throw new ReleasePublishCliError('RELEASE_INPUT_INVALID', '"id" must be a non-empty string');
  }
  if (candidate['channel'] !== 'stable' && candidate['channel'] !== 'beta') {
    throw new ReleasePublishCliError(
      'RELEASE_INPUT_INVALID',
      '"channel" must be "stable" or "beta"',
    );
  }
  if (typeof candidate['version'] !== 'string' || candidate['version'].length === 0) {
    throw new ReleasePublishCliError(
      'RELEASE_INPUT_INVALID',
      '"version" must be a non-empty string',
    );
  }
  if (typeof candidate['downloadUrl'] !== 'string' || !isHttpsUrl(candidate['downloadUrl'])) {
    throw new ReleasePublishCliError(
      'RELEASE_INPUT_INVALID',
      '"downloadUrl" must be an https:// URL',
    );
  }
  if (typeof candidate['sha256'] !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate['sha256'])) {
    throw new ReleasePublishCliError(
      'RELEASE_INPUT_INVALID',
      '"sha256" must be a 64-character lowercase hex string',
    );
  }
  const minSupportedVersion = candidate['minSupportedVersion'];
  if (minSupportedVersion !== undefined && typeof minSupportedVersion !== 'string') {
    throw new ReleasePublishCliError(
      'RELEASE_INPUT_INVALID',
      '"minSupportedVersion" must be a string when present',
    );
  }
  return {
    id: candidate['id'],
    payload: {
      channel: candidate['channel'],
      version: candidate['version'],
      downloadUrl: candidate['downloadUrl'],
      sha256: candidate['sha256'],
      ...(minSupportedVersion === undefined ? {} : { minSupportedVersion }),
    },
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validates `raw`, then signs and persists it through the injected publisher. The publisher
 * itself decides what "signing is unavailable" or "no database configured" means (a
 * `DisabledReleaseSigner`/`DisabledReleaseMetadataService` throws) — this function adds no
 * fallback of its own, so an unconfigured environment fails closed exactly like every other
 * disabled-service path in this codebase. */
export async function runReleasePublish(
  raw: unknown,
  publisher: ReleasePublisher,
): Promise<ReleaseRecord> {
  const { id, payload } = parseReleasePublishInput(raw);
  const request: ReleasePublishRequest = { id, payload };
  return publisher.publish(request);
}
