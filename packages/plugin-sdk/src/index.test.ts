import { describe, expect, it } from 'vitest';
import {
  checkPluginCompatibility,
  createPluginSdkHost,
  deprecationStatus,
  PLUGIN_CAPABILITIES,
  PLUGIN_COMPATIBILITY_FIXTURES,
  PluginCapabilityUnavailableError,
} from './index.js';

describe('Plugin SDK v1 freeze', () => {
  it('keeps every supported compatibility fixture compatible with API v1', () => {
    for (const fixture of PLUGIN_COMPATIBILITY_FIXTURES) {
      expect(checkPluginCompatibility(fixture.target).compatible, fixture.name).toBe(
        fixture.expectedCompatible,
      );
    }
  });

  it('supports exact and bounded API ranges without guessing unsupported syntax', () => {
    expect(checkPluginCompatibility({ pluginId: 'exact', joyApi: '1.0.0' }).compatible).toBe(true);
    expect(checkPluginCompatibility({ pluginId: 'old', joyApi: '<1.0.0' }).compatible).toBe(false);
    expect(checkPluginCompatibility({ pluginId: 'bad', joyApi: '^1.0.0' })).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('unsupported'),
    });
  });

  it('requires explicit capability detection instead of optimistic execution', () => {
    const host = createPluginSdkHost(['caption.pack.data']);
    expect(host.apiVersion).toBe('1.0.0');
    expect(host.supports('caption.pack.data')).toBe(true);
    expect(host.supports('ui.panel')).toBe(false);
    expect(() => host.require('ui.panel')).toThrow(PluginCapabilityUnavailableError);
    expect(() => createPluginSdkHost(['unknown' as never])).toThrow(
      'unknown Plugin SDK capability',
    );
    expect([...PLUGIN_CAPABILITIES]).toEqual(['ui.panel', 'caption.pack.data', 'provider.adapter']);
  });

  it('reports deprecations through a supported-until window', () => {
    const notices = [
      {
        symbol: 'panels.legacyRegister',
        deprecatedSince: '1.0.0',
        supportedUntilExclusive: '1.2.0',
        replacement: 'panels.register',
      },
    ] as const;
    expect(deprecationStatus('panels.legacyRegister', '1.1.0', notices)).toMatchObject({
      state: 'deprecated',
    });
    expect(deprecationStatus('panels.legacyRegister', '1.2.0', notices)).toMatchObject({
      state: 'removed',
    });
  });

  it('ships required capabilities for every supported compatibility fixture', () => {
    const host = createPluginSdkHost();
    for (const fixture of PLUGIN_COMPATIBILITY_FIXTURES.filter(
      (fixture) => fixture.expectedCompatible,
    )) {
      expect(fixture.requiredCapabilities.every((capability) => host.supports(capability))).toBe(
        true,
      );
    }
  });
});
