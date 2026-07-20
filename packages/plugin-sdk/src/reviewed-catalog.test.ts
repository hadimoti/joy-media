import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPluginPackage, ReviewedCatalog, signPluginPackage } from './index.js';
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
    const catalog = new ReviewedCatalog({
      keys: { key: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    });
    catalog.registerPublisher({
      id: 'unverified',
      displayName: 'Unverified',
      verified: false,
      signingKeyIds: ['key'],
    });
    expect(catalog.submit('unverified', { manifest, files, signature })).toBeUndefined();
    catalog.registerPublisher({
      id: 'example',
      displayName: 'Example',
      verified: true,
      signingKeyIds: ['key'],
    });
    const release = catalog.submit('example', { manifest, files, signature })!;
    expect(release).toMatchObject({
      state: 'pending',
      permissions: [],
      compatibility: '>=1.0.0 <2.0.0',
    });
    expect(catalog.submit('example', { manifest, files, signature })).toBeUndefined();
    expect(catalog.list(true)).toEqual([]);
    expect(
      catalog.review('example', manifest.id, manifest.version, 'reviewer-a', true),
    ).toMatchObject({ state: 'approved', reviewerId: 'reviewer-a' });
    expect(catalog.list(true)).toHaveLength(1);
    expect(
      catalog.revoke('example', manifest.id, manifest.version, 'security incident', true),
    ).toMatchObject({ state: 'quarantined' });
  }));
