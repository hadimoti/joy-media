import { describe, expect, it } from 'vitest';
import {
  AGENT_SETTINGS_STORAGE_KEY,
  approvalPolicyForAgentSettings,
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  localDeepSeekHarnessSettings,
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
    expect(storage.value).not.toContain('credential-value');

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

  it('rejects arbitrary reasoning-model names instead of persisting a free-form provider value', () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({
      ...DEFAULT_AGENT_SETTINGS,
      reasoningModel: 'anything-from-user-input',
    });
    expect(loadAgentSettings(storage).reasoningModel).toBe('');
  });

  it('keeps DeepSeek-harness credentials in local settings and projects only a complete local config', () => {
    const storage = new MemoryStorage();
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      joyCodeEngine: 'local-deepseek-harness' as const,
      deepSeekHarnessEndpoint: ' https://openrouter.example/v1/chat/completions ',
      deepSeekHarnessModel: 'deepseek-chat',
      deepSeekHarnessApiKey: 'credential-value',
    };
    saveAgentSettings(storage, settings);
    expect(localDeepSeekHarnessSettings(loadAgentSettings(storage))).toEqual({
      endpointUrl: 'https://openrouter.example/v1/chat/completions',
      modelId: 'deepseek-chat',
      apiKey: 'credential-value',
    });
    expect(storage.value).toContain('credential-value');
  });

  it('does not activate an incomplete local engine configuration', () => {
    expect(
      localDeepSeekHarnessSettings({
        ...DEFAULT_AGENT_SETTINGS,
        joyCodeEngine: 'local-deepseek-harness',
        deepSeekHarnessEndpoint: 'https://openrouter.example/v1/chat/completions',
      }),
    ).toBeUndefined();
  });
});
