import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decidePluginExecution,
  diffPluginPermissions,
  hashPluginPackage,
  signPluginPackage,
  validatePluginManifest,
  verifyPluginPackage,
} from './index.js';
import type { PluginManifestV1 } from './index.js';

const manifest: PluginManifestV1 = {
  manifestVersion: 1,
  id: 'example.caption-pack',
  name: 'Caption Pack',
  version: '1.0.0',
  publisher: 'Example',
  joyApi: '>=1.0.0 <2.0.0',
  contributes: { captionPacks: ['example.warm'] },
  permissions: [],
};

describe('plugin packaging and security', () => {
  it('validates granular permissions and enforces entrypoint tier prerequisites', () => {
    expect(validatePluginManifest(manifest).issues).toEqual([]);
    expect(
      validatePluginManifest({
        ...manifest,
        entrypoints: { ui: 'ui/index.js', worker: 'worker/index.js' },
        permissions: ['ui.panel'],
      }).issues.map((entry) => entry.code),
    ).toContain('plugin/tier-permission-missing');
    expect(
      validatePluginManifest({ ...manifest, permissions: ['project.read.everything'] }).issues,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'plugin/permission-invalid' })]),
    );
  });

  it('verifies an immutable package hash and Ed25519 signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const files = {
      'plugin.json': Buffer.from(JSON.stringify(manifest)),
      'data/pack.json': Buffer.from('{}'),
    };
    const packageSha256 = hashPluginPackage(files);
    const signature = signPluginPackage(
      files,
      'example-key',
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const pluginPackage = {
      manifest,
      files,
      signature,
    };
    expect(
      verifyPluginPackage(pluginPackage, {
        keys: { 'example-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      }),
    ).toMatchObject({ verified: true, packageSha256 });
    expect(
      verifyPluginPackage(
        {
          ...pluginPackage,
          files: { ...files, 'data/pack.json': Buffer.from('{"changed":true}') },
        },
        { keys: {} },
      ).issues,
    ).toEqual(
      expect.arrayContaining(['plugin/package-hash-mismatch', 'plugin/signature-key-untrusted']),
    );
    expect(
      verifyPluginPackage(
        { ...pluginPackage, manifest: { ...manifest, name: 'Tampered' } },
        { keys: {} },
      ).issues,
    ).toContain('plugin/manifest-file-mismatch');
  });

  it('shows added permissions and requires approval before an update can proceed', () => {
    const candidate = {
      ...manifest,
      permissions: ['project.read.transcript', 'ui.panel'] as const,
    };
    expect(diffPluginPermissions(manifest, candidate)).toEqual({
      added: ['project.read.transcript', 'ui.panel'],
      removed: [],
      requiresApproval: true,
    });
  });

  it('safe mode opens without third-party code execution', () => {
    const panel: PluginManifestV1 = {
      ...manifest,
      entrypoints: { ui: 'ui/index.js' },
      contributes: { panels: ['example.panel'] },
      permissions: ['ui.panel'],
    };
    expect(
      decidePluginExecution(panel, 'ui', {
        safeMode: true,
        approvedPermissions: new Set(['ui.panel']),
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'safe-mode',
    });
    expect(
      decidePluginExecution(panel, 'ui', { safeMode: false, approvedPermissions: new Set() }),
    ).toMatchObject({
      allowed: false,
      reason: 'permission-unapproved',
    });
    expect(
      decidePluginExecution(panel, 'ui', {
        safeMode: false,
        approvedPermissions: new Set(['ui.panel']),
      }),
    ).toMatchObject({
      allowed: true,
      tier: 'ui-sandbox',
    });
  });
});
