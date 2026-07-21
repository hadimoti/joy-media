import type { AnyProvider, ProviderLifecycleState, ProviderStatus } from './types.js';
import { getProviderId, getAdapterVersion, getModelVersions } from './utils.js';

interface ProviderStatusMutable {
  providerId: string;
  state: ProviderLifecycleState;
  lastHealthCheck: string | undefined;
  adapterVersion: string;
  modelVersions: readonly string[] | undefined;
  activeJobs: number;
  lastError: string | undefined;
  consecutiveFailures: number;
}

export class ProviderLifecycle {
  private readonly statuses = new Map<string, ProviderStatusMutable>();

  register(provider: AnyProvider): void {
    const id = getProviderId(provider);
    if (this.statuses.has(id)) return;

    this.statuses.set(id, {
      providerId: id,
      state: 'configured',
      lastHealthCheck: undefined,
      adapterVersion: getAdapterVersion(provider),
      modelVersions: getModelVersions(provider),
      activeJobs: 0,
      lastError: undefined,
      consecutiveFailures: 0,
    });
  }

  getStatus(providerId: string): ProviderStatus {
    const status = this.statuses.get(providerId);
    if (!status) {
      throw new Error(`Provider '${providerId}' is not registered`);
    }
    return this.toImmutable(status);
  }

  markHealthy(providerId: string): void {
    const status = this.getMutable(providerId);
    status.state = 'healthy';
    status.lastHealthCheck = new Date().toISOString();
    status.lastError = undefined;
    status.consecutiveFailures = 0;
  }

  markDegraded(providerId: string, error: string): void {
    const status = this.getMutable(providerId);
    status.state = 'degraded';
    status.lastError = error;
    status.consecutiveFailures++;
  }

  markOffline(providerId: string, error: string): void {
    const status = this.getMutable(providerId);
    status.state = 'offline';
    status.lastError = error;
    status.consecutiveFailures++;
  }

  recordJobStart(providerId: string): void {
    const status = this.getMutable(providerId);
    status.activeJobs++;
  }

  recordJobEnd(providerId: string, success: boolean): void {
    const status = this.getMutable(providerId);
    status.activeJobs = Math.max(0, status.activeJobs - 1);
    if (success) {
      status.consecutiveFailures = 0;
    } else {
      status.consecutiveFailures++;
    }
  }

  getAllStatuses(): readonly ProviderStatus[] {
    return Array.from(this.statuses.values()).map((s) => this.toImmutable(s));
  }

  private getMutable(providerId: string): ProviderStatusMutable {
    const status = this.statuses.get(providerId);
    if (!status) {
      throw new Error(`Provider '${providerId}' is not registered`);
    }
    return status;
  }

  private toImmutable(status: ProviderStatusMutable): ProviderStatus {
    const result: ProviderStatus = {
      providerId: status.providerId,
      state: status.state,
      adapterVersion: status.adapterVersion,
      activeJobs: status.activeJobs,
      consecutiveFailures: status.consecutiveFailures,
    };

    if (status.lastHealthCheck !== undefined) {
      (result as { lastHealthCheck?: string }).lastHealthCheck = status.lastHealthCheck;
    }
    if (status.modelVersions !== undefined) {
      (result as { modelVersions?: readonly string[] }).modelVersions = status.modelVersions;
    }
    if (status.lastError !== undefined) {
      (result as { lastError?: string }).lastError = status.lastError;
    }

    return result;
  }
}
