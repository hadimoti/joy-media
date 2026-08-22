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
          kind: 'image',
          displayName: 'Gold Particle Wave',
          sortName: 'gold particle wave',
          tags: ['joy-media-library', 'category-effects', 'particle'],
          descriptor: { mimeType: 'image/png', width: 1200, height: 600 },
        },
      ],
    } as const;

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

  it('registers curated wav and mp3 audio assets with optional duration metadata', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const wavDigest = 'b'.repeat(64);
    const mp3Digest = 'c'.repeat(64);
    const wavRef = `joylib-${wavDigest}`;
    const mp3Ref = `joylib-${mp3Digest}`;
    const manifest = {
      schemaVersion: 1,
      project: {
        id: 'joy-media-alpha-library',
        title: 'JOY Media Asset Library',
        ownerId: 'joy-media-library',
      },
      assets: [
        {
          id: wavRef,
          ref: wavRef,
          sha256: wavDigest,
          bytes: 18_406_332,
          kind: 'audio',
          displayName: 'Air short slow release through valve',
          sortName: 'air short slow release through valve',
          tags: ['joy-media', 'audio', 'wav', '6010'],
          descriptor: { mimeType: 'audio/wav', durationUs: 2_300_000 },
        },
        {
          id: mp3Ref,
          ref: mp3Ref,
          sha256: mp3Digest,
          bytes: 1_234_567,
          kind: 'audio',
          displayName: 'Whoosh fast thick',
          sortName: 'whoosh fast thick',
          tags: ['joy-media', 'audio', 'mp3', '6080'],
          descriptor: { mimeType: 'audio/mpeg' },
        },
      ],
    } as const;

    await expect(importAlphaLibrary(controlPlane, manifest)).resolves.toEqual({
      created: 2,
      updated: 0,
      total: 2,
    });
    await expect(
      controlPlane.assetsForProject({ id: 'joy-media-library' }, 'joy-media-alpha-library'),
    ).resolves.toMatchObject([
      {
        id: wavRef,
        kind: 'audio',
        descriptor: { mimeType: 'audio/wav', durationUs: 2_300_000 },
      },
      { id: mp3Ref, kind: 'audio', descriptor: { mimeType: 'audio/mpeg' } },
    ]);
    await pool.end();
  });

  it('rejects audio assets with image dimensions or non-audio mime types', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const base = {
      schemaVersion: 1,
      project: {
        id: 'joy-media-alpha-library',
        title: 'JOY Media Asset Library',
        ownerId: 'joy-media-library',
      },
    };
    const digest = 'd'.repeat(64);
    const asset = {
      id: `joylib-${digest}`,
      ref: `joylib-${digest}`,
      sha256: digest,
      bytes: 1234,
      kind: 'audio' as const,
      displayName: 'Invalid audio',
      sortName: 'invalid audio',
      tags: ['audio'],
    };

    await expect(
      importAlphaLibrary(controlPlane, {
        ...base,
        assets: [{ ...asset, descriptor: { mimeType: 'audio/wav', width: 640, height: 360 } }],
      }),
    ).rejects.toThrow('invalid cloud library asset');
    await expect(
      importAlphaLibrary(controlPlane, {
        ...base,
        assets: [{ ...asset, descriptor: { mimeType: 'image/png' } }],
      }),
    ).rejects.toThrow('invalid cloud library asset');
    await pool.end();
  });
});
