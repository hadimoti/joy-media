/** First-party plugin host without package signing (browser-safe, WP-18). */

import { decidePluginExecution } from './policy.js';
import type { PluginExecutionPolicy } from './policy.js';
import type { PluginEntrypoint, PluginManifestV1 } from './manifest.js';

export type FirstPartyPluginState = 'disabled' | 'enabled';

export interface FirstPartyInstalledPlugin {
  readonly manifest: PluginManifestV1;
  readonly packageSha256: string;
  readonly state: FirstPartyPluginState;
}

export type FirstPartyUpdateResult =
  | { readonly state: 'updated'; readonly plugin: FirstPartyInstalledPlugin }
  | { readonly state: 'rejected'; readonly issues: readonly string[] };

/**
 * Host-trusted first-party contributions only. Does not verify Ed25519 packages —
 * that stays on the Node `PluginLifecycle.install` path.
 */
export class FirstPartyPluginHost {
  readonly #installed = new Map<string, FirstPartyInstalledPlugin>();

  constructor(private policy: PluginExecutionPolicy) {}

  setPolicy(policy: PluginExecutionPolicy): void {
    this.policy = policy;
  }

  getPolicy(): PluginExecutionPolicy {
    return this.policy;
  }

  list(): readonly FirstPartyInstalledPlugin[] {
    return [...this.#installed.values()];
  }

  get(pluginId: string): FirstPartyInstalledPlugin | undefined {
    return this.#installed.get(pluginId);
  }

  register(manifest: PluginManifestV1, packageSha256 = 'first-party'): FirstPartyUpdateResult {
    if (this.#installed.has(manifest.id)) {
      return { state: 'rejected', issues: ['plugin/already-installed'] };
    }
    const plugin: FirstPartyInstalledPlugin = {
      manifest,
      packageSha256,
      state: 'disabled',
    };
    this.#installed.set(manifest.id, plugin);
    return { state: 'updated', plugin };
  }

  enable(pluginId: string, entrypoint: PluginEntrypoint): FirstPartyUpdateResult {
    const installed = this.#installed.get(pluginId);
    if (installed === undefined) return { state: 'rejected', issues: ['plugin/not-installed'] };
    const decision = decidePluginExecution(installed.manifest, entrypoint, this.policy);
    if (!decision.allowed) {
      return { state: 'rejected', issues: [`plugin/enable-denied:${decision.reason}`] };
    }
    const plugin = { ...installed, state: 'enabled' as const };
    this.#installed.set(pluginId, plugin);
    return { state: 'updated', plugin };
  }

  disable(pluginId: string): boolean {
    const installed = this.#installed.get(pluginId);
    if (installed === undefined) return false;
    this.#installed.set(pluginId, { ...installed, state: 'disabled' });
    return true;
  }

  /** Contribution may mount only when enabled and policy still allows the entrypoint. */
  canMount(pluginId: string, entrypoint: PluginEntrypoint): boolean {
    const installed = this.#installed.get(pluginId);
    if (installed === undefined || installed.state !== 'enabled') return false;
    return decidePluginExecution(installed.manifest, entrypoint, this.policy).allowed;
  }
}
