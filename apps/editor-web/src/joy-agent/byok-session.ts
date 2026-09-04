import type { ByokSessionConfig, ByokSessionStatus } from './protocol.js';

export interface ByokSession {
  readonly status: ByokSessionStatus;
  clear(): void;
}

export function createByokSession(
  config: ByokSessionConfig,
  status: ByokSessionStatus = {
    provider: config.provider,
    modelId: config.modelId,
    capability: 'untested',
  },
): ByokSession {
  let currentStatus = status;
  const provider = config.provider;
  // The client posts the config directly to the dedicated Worker. This helper
  // retains only public status and never keeps a second main-thread copy.
  return {
    get status() {
      return currentStatus;
    },
    clear() {
      currentStatus = { provider, modelId: '', capability: 'untested' };
    },
  };
}

export function forgetByokConfig(config: ByokSessionConfig): void {
  // Explicitly overwrite the object fields owned by this session. The caller
  // must also terminate its Worker; this helper never persists or logs keys.
  (config as { baseUrl: string; modelId: string; apiKey: string }).baseUrl = '';
  (config as { baseUrl: string; modelId: string; apiKey: string }).modelId = '';
  (config as { baseUrl: string; modelId: string; apiKey: string }).apiKey = '';
}
