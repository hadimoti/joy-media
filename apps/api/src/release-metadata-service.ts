import type { Pool } from 'pg';

/**
 * Release channel metadata for the installer/download page and the desktop app's own
 * update check (JOY Media desktop migration, wave 4). Public data — no credential, no
 * customer information — so its read route (`GET /v1/releases/:channel`) needs no auth,
 * matching the brief's "joyst.ir is reduced to ... installer/download page ... and release
 * metadata."
 *
 * Populating real rows (an actual signed Windows installer, wave 7) is out of scope here;
 * this wave only builds the storage/read contract those rows will land in.
 */

export type ReleaseChannel = 'stable' | 'beta';

export interface ReleaseRecord {
  readonly id: string;
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly signature: string;
  readonly minSupportedVersion?: string;
  readonly publishedAt: number;
}

export class ReleaseMetadataError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReleaseMetadataError';
  }
}

export interface PublishReleaseInput {
  readonly id: string;
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly signature: string;
  readonly minSupportedVersion?: string;
}

export interface ReleaseMetadataApi {
  latest(channel: ReleaseChannel): Promise<ReleaseRecord | undefined>;
  /** Not reachable from any route this wave — the wave 7 publish pipeline calls it directly
   * with owner/Codex approval; there is no public "publish a release" HTTP endpoint. */
  publish(input: PublishReleaseInput): Promise<ReleaseRecord>;
}

interface ReleaseRow {
  readonly id: string;
  readonly channel: string;
  readonly version: string;
  readonly download_url: string;
  readonly sha256: string;
  readonly signature: string;
  readonly min_supported_version: string | null;
  readonly published_at: Date;
}

export class ReleaseMetadataService implements ReleaseMetadataApi {
  private readonly pool: Pool;
  private readonly now: () => number;

  constructor(options: { readonly pool: Pool; readonly now?: () => number }) {
    this.pool = options.pool;
    this.now = options.now ?? (() => Date.now());
  }

  async latest(channel: ReleaseChannel): Promise<ReleaseRecord | undefined> {
    const result = await this.pool.query<ReleaseRow>(
      'SELECT * FROM release_metadata WHERE channel = $1 ORDER BY published_at DESC LIMIT 1',
      [channel],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : releaseOf(row);
  }

  async publish(input: PublishReleaseInput): Promise<ReleaseRecord> {
    const publishedAt = new Date(this.now());
    const result = await this.pool.query<ReleaseRow>(
      `INSERT INTO release_metadata
         (id, channel, version, download_url, sha256, signature, min_supported_version, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (channel, version) DO UPDATE SET
         download_url = $4, sha256 = $5, signature = $6, min_supported_version = $7
       RETURNING *`,
      [
        input.id,
        input.channel,
        input.version,
        input.downloadUrl,
        input.sha256,
        input.signature,
        input.minSupportedVersion ?? null,
        publishedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ReleaseMetadataError('RELEASE_PUBLISH_FAILED', 'insert failed');
    }
    return releaseOf(row);
  }
}

/** Used when JOY_MEDIA_DATABASE_URL is unset — the read route reports no release available
 * rather than the process crashing at startup, same disabled-fallback shape as the other
 * services in this wave. */
export class DisabledReleaseMetadataService implements ReleaseMetadataApi {
  async latest(_channel: ReleaseChannel): Promise<ReleaseRecord | undefined> {
    return undefined;
  }
  async publish(_input: PublishReleaseInput): Promise<ReleaseRecord> {
    throw new ReleaseMetadataError(
      'RELEASE_SERVICE_UNCONFIGURED',
      'release metadata service is not configured',
    );
  }
}

function releaseOf(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    channel: row.channel === 'beta' ? 'beta' : 'stable',
    version: row.version,
    downloadUrl: row.download_url,
    sha256: row.sha256,
    signature: row.signature,
    ...(row.min_supported_version !== null
      ? { minSupportedVersion: row.min_supported_version }
      : {}),
    publishedAt: row.published_at.getTime(),
  };
}
