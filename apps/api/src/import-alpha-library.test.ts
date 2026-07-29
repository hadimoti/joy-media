import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { importAlphaLibrary } from './import-alpha-library.js';
import { PostgresControlPlane } from './postgres-control-plane.js';

describe('importAlphaLibrary', () => {
  it('creates and idempotently updates private cloud library records', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const digest = 'a'.repeat(64);
    const ref = 'joylib-' + digest;
    const manifest = {
      schemaVersion: 1,
      project: {
        id: 'joy-media-alpha-library',
        title: 'JOY Media Asset Library',
        ownerId: 'joy-media-library',
      },
      assets: [
        {
          id: ref,
          ref,
          sha256: digest,
          bytes: 1234,
          displayName: 'Gold Particle Wave',
          sortName: 'gold particle wave',
          tags: ['joy-media-library', 'category-effects', 'particle'],
          descriptor: { mimeType: 'image/png', width: 1200, height: 600 },
        },
      ],
    };

    await expect(importAlphaLibrary(controlPlane, manifest)).resolves.toEqual({
      created: 1,
      updated: 0,
      total: 1,
    });
    await expect(
      controlPlane.assetsForProject({ id: 'joy-media-library' }, 'joy-media-alpha-library'),
    ).resolves.toMatchObject([
      {
        id: ref,
        displayName: 'Gold Particle Wave',
        locations: [{ kind: 'private-object', ref }],
        tags: ['joy-media-library', 'category-effects', 'particle'],
      },
    ]);
    await expect(importAlphaLibrary(controlPlane, manifest)).resolves.toEqual({
      created: 0,
      updated: 1,
      total: 1,
    });
    await pool.end();
  });
});
