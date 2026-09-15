import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import {
  DisabledReleaseMetadataService,
  ReleaseMetadataService,
} from './release-metadata-service.js';

function pool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function service(now?: () => number) {
  const db = pool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS release_metadata (
      id text PRIMARY KEY, channel text NOT NULL, version text NOT NULL,
      download_url text NOT NULL, sha256 text NOT NULL, signature text NOT NULL,
      min_supported_version text, published_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX release_metadata_channel_version_idx ON release_metadata (channel, version);
  `);
  const releases = new ReleaseMetadataService(now === undefined ? { pool: db } : { pool: db, now });
  return { releases, db };
}

function sampleInput(overrides: Partial<Parameters<ReleaseMetadataService['publish']>[0]> = {}) {
  return {
    id: 'rel-1',
    channel: 'stable' as const,
    version: '1.0.0',
    downloadUrl: 'https://joyst.ir/download/joy-media-1.0.0.exe',
    sha256: 'a'.repeat(64),
    signature: 'b'.repeat(88),
    ...overrides,
  };
}

describe('ReleaseMetadataService', () => {
  it('returns undefined for a channel with nothing published', async () => {
    const { releases } = await service();
    expect(await releases.latest('stable')).toBeUndefined();
  });

  it('publishes a release and reads it back by channel', async () => {
    const { releases } = await service();
    const published = await releases.publish(sampleInput());
    expect(await releases.latest('stable')).toEqual(published);
  });

  it('returns the most recently published version for a channel', async () => {
    let now = 1_000;
    const { releases } = await service(() => now);
    await releases.publish(sampleInput({ version: '1.0.0' }));
    now = 2_000;
    const second = await releases.publish(sampleInput({ id: 'rel-2', version: '1.1.0' }));
    expect(await releases.latest('stable')).toEqual(second);
  });

  it('keeps stable and beta channels independent', async () => {
    const { releases } = await service();
    const stable = await releases.publish(sampleInput({ channel: 'stable' }));
    const beta = await releases.publish(
      sampleInput({ id: 'rel-2', channel: 'beta', version: '1.1.0-beta.1' }),
    );
    expect(await releases.latest('stable')).toEqual(stable);
    expect(await releases.latest('beta')).toEqual(beta);
  });

  it('republishing the same channel+version updates the artifact fields in place', async () => {
    const { releases } = await service();
    await releases.publish(sampleInput({ sha256: 'a'.repeat(64) }));
    const republished = await releases.publish(sampleInput({ sha256: 'c'.repeat(64) }));
    expect(republished.sha256).toBe('c'.repeat(64));
    expect(await releases.latest('stable')).toMatchObject({ sha256: 'c'.repeat(64) });
  });

  it('carries an optional minSupportedVersion through, or omits it entirely', async () => {
    const { releases } = await service();
    const withMin = await releases.publish(sampleInput({ minSupportedVersion: '0.9.0' }));
    expect(withMin.minSupportedVersion).toBe('0.9.0');

    const { releases: releases2 } = await service();
    const withoutMin = await releases2.publish(sampleInput());
    expect(withoutMin.minSupportedVersion).toBeUndefined();
  });
});

describe('DisabledReleaseMetadataService', () => {
  it('reports no release available rather than throwing on read', async () => {
    const disabled = new DisabledReleaseMetadataService();
    await expect(disabled.latest('stable')).resolves.toBeUndefined();
  });

  it('refuses to publish', async () => {
    const disabled = new DisabledReleaseMetadataService();
    await expect(disabled.publish(sampleInput())).rejects.toMatchObject({
      code: 'RELEASE_SERVICE_UNCONFIGURED',
    });
  });
});
