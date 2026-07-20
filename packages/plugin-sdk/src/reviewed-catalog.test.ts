import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashPluginPackage,
  ReviewedCatalog,
  signPluginPackage,
  StaticCatalogAuthorization,
} from './index.js';
import type { PluginManifestV1 } from './index.js';
describe('reviewed catalog', () =>
  it('admits only verified publishers and immutable signed releases, then revokes them', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const manifest: PluginManifestV1 = {
      manifestVersion: 1,
      id: 'example.panel',
      name: 'Panel',
      version: '1.0.0',
      publisher: 'Example',
      joyApi: '>=1.0.0 <2.0.0',
      contributes: { panels: ['example.panel'] },
      permissions: [],
    };
    const files = { 'plugin.json': Buffer.from(JSON.stringify(manifest)) };
    const signature = signPluginPackage(
      files,
      'key',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    expect(signature.packageSha256).toBe(hashPluginPackage(files));
    const trust = { keys: { key: publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
    const authorization = new StaticCatalogAuthorization({
      admin: ['publisher.register'],
      example: ['release.submit'],
      reviewer: ['release.review', 'release.revoke'],
    });
    const catalog = new ReviewedCatalog(trust, authorization);
    expect(
      catalog.registerPublisher('example', {
        id: 'unverified',
        displayName: 'Unverified',
        verified: false,
        signingKeyIds: ['key'],
      }),
    ).toBe(false);
    expect(
      catalog.registerPublisher('admin', {
        id: 'example',
        displayName: 'Example',
        verified: true,
        signingKeyIds: ['key'],
      }),
    ).toBe(true);
    expect(
      catalog.registerPublisher('admin', {
        id: 'example',
        displayName: 'Changed',
        verified: true,
        signingKeyIds: ['key'],
      }),
    ).toBe(false);
    expect(catalog.submit('unverified', 'example', { manifest, files, signature })).toBeUndefined();
    const release = catalog.submit('example', 'example', { manifest, files, signature })!;
    expect(release).toMatchObject({
      state: 'pending',
      permissions: [],
      compatibility: '>=1.0.0 <2.0.0',
    });
    expect(catalog.submit('example', 'example', { manifest, files, signature })).toBeUndefined();
    expect(catalog.list(true)).toEqual([]);
    expect(
      catalog.review('example', 'example', manifest.id, manifest.version, true),
    ).toBeUndefined();
    expect(
      catalog.review('reviewer', 'example', manifest.id, manifest.version, true),
    ).toMatchObject({ state: 'approved', reviewerId: 'reviewer' });
    expect(catalog.list(true)).toHaveLength(1);
    expect(
      catalog.revoke(
        'reviewer',
        'example',
        manifest.id,
        manifest.version,
        'security incident',
        true,
      ),
    ).toMatchObject({ state: 'quarantined' });
    expect(catalog.audit().some((entry) => entry.actorId === 'unverified' && !entry.allowed)).toBe(
      true,
    );
    const reopened = new ReviewedCatalog(trust, authorization, catalog.snapshot());
    expect(reopened.list()).toEqual(catalog.list());
    expect(reopened.audit()).toEqual(catalog.audit());
  }));
