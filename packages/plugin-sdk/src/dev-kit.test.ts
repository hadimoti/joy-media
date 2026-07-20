import { describe, expect, it } from 'vitest';
import {
  createPluginScaffold,
  pluginRenderSnapshot,
  runPluginFixture,
  simulatePluginPermissions,
} from './index.js';

describe('plugin developer kit', () => {
  it('scaffolds the three published v1 extension shapes', () => {
    const panel = createPluginScaffold({
      id: 'example.panel',
      name: 'Panel',
      publisher: 'Example',
      kind: 'panel',
    });
    const captions = createPluginScaffold({
      id: 'example.captions',
      name: 'Captions',
      publisher: 'Example',
      kind: 'caption-pack',
    });
    const provider = createPluginScaffold({
      id: 'example.provider',
      name: 'Provider',
      publisher: 'Example',
      kind: 'provider-adapter',
    });
    expect(panel.manifest.entrypoints).toEqual({ ui: 'ui/index.js' });
    expect(captions.manifest.entrypoints).toBeUndefined();
    expect(provider.manifest.entrypoints).toEqual({ worker: 'worker/index.js' });
  });

  it('simulates permission and safe-mode results without executing plugin code', () => {
    const panel = createPluginScaffold({
      id: 'example.panel',
      name: 'Panel',
      publisher: 'Example',
      kind: 'panel',
    }).manifest;
    expect(simulatePluginPermissions(panel, [])).toEqual([
      { entrypoint: 'ui', allowed: false, reason: 'permission-unapproved' },
    ]);
    expect(simulatePluginPermissions(panel, ['ui.panel'], true)).toEqual([
      { entrypoint: 'ui', allowed: false, reason: 'safe-mode' },
    ]);
    expect(simulatePluginPermissions(panel, ['ui.panel'])).toEqual([
      { entrypoint: 'ui', allowed: true },
    ]);
  });

  it('runs manifest/permission fixtures and creates canonical snapshots', () => {
    const panel = createPluginScaffold({
      id: 'example.panel',
      name: 'Panel',
      publisher: 'Example',
      kind: 'panel',
    }).manifest;
    expect(
      runPluginFixture({
        name: 'panel',
        manifest: panel,
        policy: { safeMode: false, approvedPermissions: new Set(['ui.panel']) },
        expectedManifestValid: true,
        expectedEntrypoints: [{ entrypoint: 'ui', allowed: true }],
      }),
    ).toEqual({ passed: true, failures: [] });
    expect(pluginRenderSnapshot({ b: [2, 1], a: 'JOY' })).toBe(
      pluginRenderSnapshot({ a: 'JOY', b: [2, 1] }),
    );
  });
});
