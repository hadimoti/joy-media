/** Browser-safe execution policy — no Node crypto (§24.5 safe mode). */

import { executionTierFor } from './manifest.js';
import type { PluginEntrypoint, PluginExecutionTier, PluginManifestV1, PluginPermission } from './manifest.js';

export interface PluginExecutionPolicy {
  readonly safeMode: boolean;
  /** Server plugins are never enabled by default. */
  readonly allowServerPlugins?: boolean;
  readonly approvedPermissions: ReadonlySet<PluginPermission>;
}

export interface PluginExecutionDecision {
  readonly allowed: boolean;
  readonly tier: PluginExecutionTier;
  readonly reason?:
    | 'safe-mode'
    | 'server-plugin-disabled'
    | 'permission-unapproved'
    | 'entrypoint-missing';
}

/** Blocks all third-party code in safe mode and enforces tier permissions. */
export function decidePluginExecution(
  manifest: PluginManifestV1,
  entrypoint: PluginEntrypoint,
  policy: PluginExecutionPolicy,
): PluginExecutionDecision {
  const tier = executionTierFor(manifest);
  if (manifest.entrypoints?.[entrypoint] === undefined)
    return { allowed: false, tier, reason: 'entrypoint-missing' };
  if (policy.safeMode) return { allowed: false, tier, reason: 'safe-mode' };
  if (tier === 'server-plugin' && policy.allowServerPlugins !== true) {
    return { allowed: false, tier, reason: 'server-plugin-disabled' };
  }
  const missing = manifest.permissions.some(
    (permission) => !policy.approvedPermissions.has(permission),
  );
  if (missing) return { allowed: false, tier, reason: 'permission-unapproved' };
  return { allowed: true, tier };
}
