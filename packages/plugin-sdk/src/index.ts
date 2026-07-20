/** @joy-media/plugin-sdk — stable public JOY extension contracts (P08). */

export const PACKAGE_NAME = '@joy-media/plugin-sdk' as const;

export type { PluginCapability, PluginSdkHost } from './api.js';
export {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  PluginCapabilityUnavailableError,
  createPluginSdkHost,
} from './api.js';

export type { PluginCompatibilityTarget, CompatibilityResult } from './compatibility.js';
export { checkPluginCompatibility } from './compatibility.js';

export type { PluginApiDeprecation, DeprecationStatus } from './deprecation.js';
export { PLUGIN_API_DEPRECATIONS, deprecationStatus } from './deprecation.js';

export type { PluginCompatibilityFixture } from './fixtures.js';
export { PLUGIN_COMPATIBILITY_FIXTURES } from './fixtures.js';

export type {
  PluginEntrypoint,
  PluginExecutionTier,
  PluginPermission,
  PluginEntrypointMap,
  PluginContributionsV1,
  PluginManifestV1,
  PluginManifestIssue,
  ValidatedPluginManifest,
} from './manifest.js';
export {
  PLUGIN_ENTRYPOINTS,
  PLUGIN_EXECUTION_TIERS,
  executionTierFor,
  isPluginPermission,
  validatePluginManifest,
} from './manifest.js';

export type {
  PluginPackageSignatureV1,
  PluginPackageV1,
  PluginTrustStore,
  PluginVerificationResult,
  PluginPermissionDiff,
  PluginExecutionPolicy,
  PluginExecutionDecision,
} from './security.js';
export {
  decidePluginExecution,
  diffPluginPermissions,
  hashPluginPackage,
  verifyPluginPackage,
} from './security.js';

export type {
  InstalledPluginState,
  InstalledPlugin,
  PluginProjectData,
  ProjectPluginDependency,
  ProjectPluginResolution,
  PluginMigration,
  PluginUpdateResult,
} from './lifecycle.js';
export { PluginLifecycle } from './lifecycle.js';

export type {
  PluginScaffoldOptions,
  PluginScaffold,
  PermissionSimulation,
  PluginFixture,
} from './dev-kit.js';
export {
  createPluginScaffold,
  pluginRenderSnapshot,
  runPluginFixture,
  simulatePluginPermissions,
} from './dev-kit.js';
