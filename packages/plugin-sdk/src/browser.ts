/** Browser-safe plugin-sdk surface — no Node crypto (WP-18). */

export type { PluginCapability, PluginSdkHost } from './api.js';
export {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  PluginCapabilityUnavailableError,
  createPluginSdkHost,
} from './api.js';

export type {
  PluginEntrypoint,
  PluginManifestV1,
  PluginPermission,
  PluginContributionsV1,
} from './manifest.js';
export { PLUGIN_ENTRYPOINTS, validatePluginManifest } from './manifest.js';

export type { PluginExecutionDecision, PluginExecutionPolicy } from './policy.js';
export { decidePluginExecution } from './policy.js';

export type {
  FirstPartyInstalledPlugin,
  FirstPartyPluginState,
  FirstPartyUpdateResult,
} from './first-party-host.js';
export { FirstPartyPluginHost } from './first-party-host.js';
