import { describe, expect, it } from 'vitest';
import {
  AGENT_SETTINGS_STORAGE_KEY,
  approvalPolicyForAgentSettings,
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  saveAgentSettings,
} from './agent-settings.js';

class MemoryStorage {
  value: string | null = null;
  getItem(key: string): string | null {
    return key === AGENT_SETTINGS_STORAGE_KEY ? this.value : null;
  }
  setItem(key: string, value: string): void {
    if (key === AGENT_SETTINGS_STORAGE_KEY) this.value = value;
  }
}

describe('agent settings', () => {
  it('persists KiloCode policy preferences without credential values', () => {
    const storage = new MemoryStorage();
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      executionMode: 'full-auto-limited' as const,
      maxCostPerRunUsd: 3.5,
      privacyMode: 'local-only' as const,
    };

    saveAgentSettings(storage, settings);
    expect(loadAgentSettings(storage)).toEqual(settings);
    expect(storage.value).not.toMatch(/apiKey|token|password|secret/i);

    const policy = approvalPolicyForAgentSettings(settings);
    expect(policy.executionMode).toBe('full-auto-limited');
    expect(policy.autoApproveLimit).toEqual({ amount: '3.50', currency: 'USD' });
    expect(policy.blockRemoteUploads).toBe(true);
  });

  it('fails closed to safe defaults for malformed preferences', () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      activeHost: 'hermes',
      executionMode: 'unbounded',
      maxCostPerRunUsd: -1,
      allowedCapabilities: ['credential.read'],
    });

    expect(loadAgentSettings(storage)).toEqual(DEFAULT_AGENT_SETTINGS);
  });
});
