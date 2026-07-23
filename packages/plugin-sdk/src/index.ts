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
} from './security.js';
export {
  diffPluginPermissions,
  hashPluginPackage,
  signPluginPackage,
  verifyPluginPackage,
} from './security.js';

export type { PluginExecutionPolicy, PluginExecutionDecision } from './policy.js';
export { decidePluginExecution } from './policy.js';

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
  FirstPartyInstalledPlugin,
  FirstPartyPluginState,
  FirstPartyUpdateResult,
} from './first-party-host.js';
export { FirstPartyPluginHost } from './first-party-host.js';

export type {
  PluginScaffoldOptions,
  PluginScaffold,
  PermissionSimulation,
  PluginFixture,
} from './dev-kit.js';

export type {
  TemplateVariableValue,
  TemplateSlotMedia,
  TemplateFitPolicy,
  TemplateDurationRule,
  TemplateCatalogScope,
  TeamTemplateVariable,
  TeamTemplateSlot,
  TeamTemplateV1,
  TemplateQualityIssue,
} from './templates.js';
export { TeamTemplateCatalog, validateTeamTemplate } from './templates.js';
export type {
  CatalogAuditRecord,
  CatalogAuthorization,
  CatalogPermission,
  CatalogPublisher,
  CatalogReleaseState,
  ReviewedCatalogSnapshot,
  ReviewedRelease,
} from './reviewed-catalog.js';
export { ReviewedCatalog, StaticCatalogAuthorization } from './reviewed-catalog.js';
export {
  createPluginScaffold,
  pluginRenderSnapshot,
  runPluginFixture,
  simulatePluginPermissions,
} from './dev-kit.js';
