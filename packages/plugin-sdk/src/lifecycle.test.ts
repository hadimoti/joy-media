import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPluginPackage, PluginLifecycle } from './index.js';
import type { PluginExecutionPolicy, PluginManifestV1, PluginPackageV1 } from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const trustStore = { keys: { test: publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
const policy: PluginExecutionPolicy = {
  safeMode: false,
  approvedPermissions: new Set(['ui.panel', 'project.read.transcript']),
};

function pluginPackage(
  version = '1.0.0',
  permissions: readonly ('ui.panel' | 'project.read.transcript')[] = ['ui.panel'],
): PluginPackageV1 {
  const manifest: PluginManifestV1 = {
    manifestVersion: 1,
    id: 'example.panel',
    name: 'Example panel',
    version,
    publisher: 'Example',
    joyApi: '>=1.0.0 <2.0.0',
    entrypoints: { ui: 'ui/index.js' },
    contributes: { panels: ['example.panel'] },
    permissions,
  };
  const files = {
    'plugin.json': Buffer.from(JSON.stringify(manifest)),
    'ui/index.js': Buffer.from('export {};'),
  };
  const packageSha256 = hashPluginPackage(files);
  return {
    manifest,
    files,
    signature: {
      algorithm: 'ed25519',
      keyId: 'test',
      packageSha256,
      signatureBase64: sign(null, Buffer.from(packageSha256), privateKey).toString('base64'),
    },
  };
}

describe('plugin lifecycle', () => {
  it('installs disabled, enables through policy, and disables without touching project data', () => {
    const lifecycle = new PluginLifecycle(trustStore, policy);
    const packageV1 = pluginPackage();
    expect(lifecycle.install(packageV1)).toMatchObject({
      state: 'updated',
      plugin: { state: 'disabled' },
    });
    expect(lifecycle.enable('example.panel', 'ui')).toMatchObject({
      state: 'updated',
      plugin: { state: 'enabled' },
    });
    const projectData = { 'example.panel': { selectedPreset: 'warm' } };
    expect(lifecycle.disable('example.panel')).toBe(true);
    expect(projectData).toEqual({ 'example.panel': { selectedPreset: 'warm' } });
    expect(
      lifecycle.resolveProjectDependencies([
        {
          projectId: 'project-1',
          pluginId: 'example.panel',
          requiredVersion: '1.0.0',
          fallback: 'editable',
        },
      ]),
    ).toEqual([{ pluginId: 'example.panel', state: 'disabled', mode: 'editable' }]);
  });

  it('gates added permissions and requires an exact migration for persisted data', () => {
    const lifecycle = new PluginLifecycle(trustStore, policy);
    lifecycle.install(pluginPackage());
    const candidate = pluginPackage('1.1.0', ['ui.panel', 'project.read.transcript']);
    expect(
      lifecycle.update('example.panel', candidate, { approveAddedPermissions: false }),
    ).toEqual({
      state: 'permission-approval-required',
      addedPermissions: ['project.read.transcript'],
    });
    const projectData = { 'example.panel': { selectedPreset: 'warm' } };
    expect(
      lifecycle.update('example.panel', candidate, { approveAddedPermissions: true, projectData }),
    ).toEqual({
      state: 'migration-required',
    });
    expect(
      lifecycle.update('example.panel', candidate, {
        approveAddedPermissions: true,
        projectData,
        migration: {
          fromVersion: '1.0.0',
          toVersion: '1.1.0',
          migrate: (data) => ({ ...(data as object), migrated: true }),
        },
      }),
    ).toMatchObject({
      state: 'updated',
      plugin: { manifest: { version: '1.1.0' } },
      migratedProjectData: { selectedPreset: 'warm', migrated: true },
    });
  });

  it('uninstalls registration only and leaves projects in a declared degraded mode', () => {
    const lifecycle = new PluginLifecycle(trustStore, policy);
    lifecycle.install(pluginPackage());
    const dependencies = [
      {
        projectId: 'project-1',
        pluginId: 'example.panel',
        requiredVersion: '1.0.0',
        fallback: 'read-only',
      },
    ] as const;
    expect(lifecycle.uninstall('example.panel', dependencies)).toEqual(['project-1']);
    expect(lifecycle.resolveProjectDependencies(dependencies)).toEqual([
      { pluginId: 'example.panel', state: 'missing', mode: 'read-only' },
    ]);
  });
});
