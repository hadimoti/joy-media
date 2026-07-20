import { PLUGIN_API_VERSION } from './api.js';
import { checkPluginCompatibility } from './compatibility.js';

export interface PluginApiDeprecation {
  readonly symbol: string;
  readonly deprecatedSince: string;
  readonly supportedUntilExclusive: string;
  readonly replacement: string;
}

export interface DeprecationStatus {
  readonly state: 'active' | 'deprecated' | 'removed';
  readonly notice?: PluginApiDeprecation;
}

/** v1 begins with no deprecated symbols; entries are append-only release notes. */
export const PLUGIN_API_DEPRECATIONS: readonly PluginApiDeprecation[] = [];

export function deprecationStatus(
  symbol: string,
  hostVersion: string = PLUGIN_API_VERSION,
  deprecations = PLUGIN_API_DEPRECATIONS,
): DeprecationStatus {
  const notice = deprecations.find((entry) => entry.symbol === symbol);
  if (notice === undefined) return { state: 'active' };
  const stillSupported = checkPluginCompatibility(
    { pluginId: 'deprecation-policy', joyApi: `<${notice.supportedUntilExclusive}` },
    hostVersion,
  ).compatible;
  return stillSupported ? { state: 'deprecated', notice } : { state: 'removed', notice };
}
