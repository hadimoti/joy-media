/** Non-destructive plugin lifecycle and project degradation contract (§24.7). */

import { diffPluginPermissions, verifyPluginPackage } from './security.js';
import type { PluginExecutionPolicy, PluginPackageV1, PluginTrustStore } from './security.js';
import { decidePluginExecution } from './security.js';
import type { PluginEntrypoint, PluginManifestV1 } from './manifest.js';

export type InstalledPluginState = 'disabled' | 'enabled';

export interface InstalledPlugin {
  readonly manifest: PluginManifestV1;
  readonly packageSha256: string;
  readonly state: InstalledPluginState;
}

export interface PluginProjectData {
  /** Namespaced opaque data stays intact when a plugin is absent or disabled. */
  readonly [pluginId: string]: unknown;
}

export interface ProjectPluginDependency {
  readonly projectId: string;
  readonly pluginId: string;
  readonly requiredVersion: string;
  readonly fallback: 'editable' | 'read-only';
}

export interface ProjectPluginResolution {
  readonly pluginId: string;
  readonly state: 'available' | 'disabled' | 'missing';
  readonly mode: 'editable' | 'read-only';
}

export interface PluginMigration {
  readonly fromVersion: string;
  readonly toVersion: string;
  migrate(projectData: unknown): unknown;
}

export type PluginUpdateResult =
  | {
      readonly state: 'updated';
      readonly plugin: InstalledPlugin;
      /** Present when a versioned migration transformed namespaced project data. */
      readonly migratedProjectData?: unknown;
    }
  | { readonly state: 'permission-approval-required'; readonly addedPermissions: readonly string[] }
  | { readonly state: 'migration-required' }
  | { readonly state: 'rejected'; readonly issues: readonly string[] };

export class PluginLifecycle {
  readonly #installed = new Map<string, InstalledPlugin>();

  constructor(
    private readonly trustStore: PluginTrustStore,
    private readonly policy: PluginExecutionPolicy,
  ) {}

  list(): readonly InstalledPlugin[] {
    return [...this.#installed.values()];
  }

  get(pluginId: string): InstalledPlugin | undefined {
    return this.#installed.get(pluginId);
  }

  /** Installs a verified package disabled by default; install never executes code. */
  install(pluginPackage: PluginPackageV1): PluginUpdateResult {
    const verification = verifyPluginPackage(pluginPackage, this.trustStore);
    if (!verification.verified || verification.manifest === undefined) {
      return { state: 'rejected', issues: verification.issues };
    }
    if (this.#installed.has(verification.manifest.id)) {
      return { state: 'rejected', issues: ['plugin/already-installed'] };
    }
    const plugin: InstalledPlugin = {
      manifest: verification.manifest,
      packageSha256: verification.packageSha256,
      state: 'disabled',
    };
    this.#installed.set(plugin.manifest.id, plugin);
    return { state: 'updated', plugin };
  }

  /** Enables one declared code entrypoint only when the central policy allows it. */
  enable(pluginId: string, entrypoint: PluginEntrypoint): PluginUpdateResult {
    const installed = this.#installed.get(pluginId);
    if (installed === undefined) return { state: 'rejected', issues: ['plugin/not-installed'] };
    const decision = decidePluginExecution(installed.manifest, entrypoint, this.policy);
    if (!decision.allowed)
      return { state: 'rejected', issues: [`plugin/enable-denied:${decision.reason}`] };
    const plugin = { ...installed, state: 'enabled' as const };
    this.#installed.set(pluginId, plugin);
    return { state: 'updated', plugin };
  }

  /** Disabling changes only lifecycle state; project plugin data is deliberately untouched. */
  disable(pluginId: string): boolean {
    const installed = this.#installed.get(pluginId);
    if (installed === undefined) return false;
    this.#installed.set(pluginId, { ...installed, state: 'disabled' });
    return true;
  }

  /**
   * Updates a package after verification. Added permissions require an explicit
   * approval, and persisted plugin data requires an exact migration step.
   */
  update(
    pluginId: string,
    candidate: PluginPackageV1,
    options: {
      readonly approveAddedPermissions: boolean;
      readonly projectData?: PluginProjectData;
      readonly migration?: PluginMigration;
    },
  ): PluginUpdateResult {
    const installed = this.#installed.get(pluginId);
    if (installed === undefined) return { state: 'rejected', issues: ['plugin/not-installed'] };
    const verification = verifyPluginPackage(candidate, this.trustStore);
    if (!verification.verified || verification.manifest === undefined) {
      return { state: 'rejected', issues: verification.issues };
    }
    if (verification.manifest.id !== pluginId) {
      return { state: 'rejected', issues: ['plugin/update-id-mismatch'] };
    }
    const permissionDiff = diffPluginPermissions(installed.manifest, verification.manifest);
    if (permissionDiff.requiresApproval && !options.approveAddedPermissions) {
      return { state: 'permission-approval-required', addedPermissions: permissionDiff.added };
    }
    const existingData = options.projectData?.[pluginId];
    let migratedProjectData: unknown;
    if (
      existingData !== undefined &&
      installed.manifest.version !== verification.manifest.version
    ) {
      const migration = options.migration;
      if (
        migration === undefined ||
        migration.fromVersion !== installed.manifest.version ||
        migration.toVersion !== verification.manifest.version
      ) {
        return { state: 'migration-required' };
      }
      // Execute the migration before recording the new package. The host owns
      // persistence and writes this returned value atomically with the update.
      migratedProjectData = migration.migrate(existingData);
    }
    const plugin: InstalledPlugin = {
      manifest: verification.manifest,
      packageSha256: verification.packageSha256,
      state: installed.state,
    };
    this.#installed.set(pluginId, plugin);
    return {
      state: 'updated',
      plugin,
      ...(migratedProjectData === undefined ? {} : { migratedProjectData }),
    };
  }

  /**
   * Removes executable package registration only. Callers retain the returned
   * dependent project IDs and all namespaced data for a later reinstall.
   */
  uninstall(pluginId: string, dependencies: readonly ProjectPluginDependency[]): readonly string[] {
    this.#installed.delete(pluginId);
    return dependencies
      .filter((dependency) => dependency.pluginId === pluginId)
      .map((dependency) => dependency.projectId);
  }

  /** Missing/disabled dependencies degrade a project but never remove its data. */
  resolveProjectDependencies(
    dependencies: readonly ProjectPluginDependency[],
  ): readonly ProjectPluginResolution[] {
    return dependencies.map((dependency) => {
      const installed = this.#installed.get(dependency.pluginId);
      if (installed === undefined) {
        return { pluginId: dependency.pluginId, state: 'missing', mode: dependency.fallback };
      }
      if (installed.state === 'disabled') {
        return { pluginId: dependency.pluginId, state: 'disabled', mode: dependency.fallback };
      }
      return { pluginId: dependency.pluginId, state: 'available', mode: 'editable' };
    });
  }
}
