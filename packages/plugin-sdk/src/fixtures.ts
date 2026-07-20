import type { PluginCapability } from './api.js';
import type { PluginCompatibilityTarget } from './compatibility.js';

export interface PluginCompatibilityFixture {
  readonly name: string;
  readonly target: PluginCompatibilityTarget;
  readonly requiredCapabilities: readonly PluginCapability[];
  readonly expectedCompatible: boolean;
}

/** Supported plugin fixtures are a public compatibility promise, not samples. */
export const PLUGIN_COMPATIBILITY_FIXTURES: readonly PluginCompatibilityFixture[] = [
  {
    name: 'v1-panel',
    target: { pluginId: 'example.panel-v1', joyApi: '>=1.0.0 <2.0.0' },
    requiredCapabilities: ['ui.panel'],
    expectedCompatible: true,
  },
  {
    name: 'v1-caption-pack',
    target: { pluginId: 'example.captions-v1', joyApi: '>=1.0.0 <2.0.0' },
    requiredCapabilities: ['caption.pack.data'],
    expectedCompatible: true,
  },
  {
    name: 'v1-provider-adapter',
    target: { pluginId: 'example.provider-v1', joyApi: '>=1.0.0 <2.0.0' },
    requiredCapabilities: ['provider.adapter'],
    expectedCompatible: true,
  },
  {
    name: 'future-major-is-rejected',
    target: { pluginId: 'example.future-v2', joyApi: '>=2.0.0 <3.0.0' },
    requiredCapabilities: [],
    expectedCompatible: false,
  },
];
