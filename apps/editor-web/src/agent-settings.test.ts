import { describe, expect, it } from 'vitest';
import {
  AGENT_SETTINGS_STORAGE_KEY,
  approvalPolicyForAgentSettings,
  DEFAULT_AGENT_SETTINGS,
  loadAgentSettings,
  localDeepSeekHarnessSettings,
  createInMemoryCredentialStore,
  LOCAL_DEEPSEEK_HARNESS_CREDENTIAL_REF,
  canUseLocalDeepSeekHarness,
  canRunLocalDeepSeekHarness,
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
      localProviderDisclosureAccepted: true,
    };
    saveAgentSettings(storage, settings);
    expect(storage.value).not.toContain('credential-value');
    const credentialStore = createInMemoryCredentialStore();
    credentialStore.set(
      LOCAL_DEEPSEEK_HARNESS_CREDENTIAL_REF,
      `  ${settings.deepSeekHarnessApiKey}  `,
    );
    expect(localDeepSeekHarnessSettings(loadAgentSettings(storage), credentialStore)).toEqual({
      endpointUrl: 'https://openrouter.example/v1/chat/completions',
      modelId: 'deepseek-chat',
      apiKey: 'credential-value',
    });
    expect(loadAgentSettings(storage).deepSeekHarnessApiKey).toBe('');
    expect(loadAgentSettings(storage).localProviderDisclosureAccepted).toBe(true);
  });

  it('does not activate an incomplete local engine configuration', () => {
    expect(
      localDeepSeekHarnessSettings(
        {
          ...DEFAULT_AGENT_SETTINGS,
          joyCodeEngine: 'local-deepseek-harness',
          deepSeekHarnessEndpoint: 'https://openrouter.example/v1/chat/completions',
        },
        createInMemoryCredentialStore(),
      ),
    ).toBeUndefined();
  });

  it('allows loopback endpoints but requires auth and disclosure for remote endpoints', () => {
    const localOnly = { privacyMode: 'local-only' as const };
    const asksBeforeRemote = { privacyMode: 'ask-before-remote' as const };
    expect(
      canUseLocalDeepSeekHarness(localOnly, {
        endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
        authenticatedSessionReady: false,
        disclosureAccepted: false,
      }),
    ).toBe(true);
    expect(
      canUseLocalDeepSeekHarness(localOnly, {
        endpointUrl: 'https://provider.example/v1/chat/completions',
        authenticatedSessionReady: true,
        disclosureAccepted: true,
      }),
    ).toBe(false);
    expect(
      canUseLocalDeepSeekHarness(asksBeforeRemote, {
        endpointUrl: 'https://provider.example/v1/chat/completions',
        authenticatedSessionReady: true,
        disclosureAccepted: true,
      }),
    ).toBe(true);
    expect(
      canUseLocalDeepSeekHarness(asksBeforeRemote, {
        endpointUrl: 'https://provider.example/v1/chat/completions',
        authenticatedSessionReady: true,
        disclosureAccepted: false,
      }),
    ).toBe(false);
  });

  it('fails closed instead of falling back when local DSH selection is incomplete', () => {
    const settings = {
      joyCodeEngine: 'local-deepseek-harness' as const,
      privacyMode: 'ask-before-remote' as const,
    };
    const context = {
      endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      authenticatedSessionReady: false,
      disclosureAccepted: false,
    };
    expect(canRunLocalDeepSeekHarness(settings, undefined, context)).toBe(false);
    const remoteSettings = {
      endpointUrl: 'https://provider.example/v1/chat/completions',
      modelId: 'deepseek-chat',
      apiKey: 'local-key',
    };
    expect(
      canRunLocalDeepSeekHarness(settings, remoteSettings, {
        ...context,
        endpointUrl: remoteSettings.endpointUrl,
        authenticatedSessionReady: false,
        disclosureAccepted: true,
      }),
    ).toBe(false);
    expect(
      canRunLocalDeepSeekHarness(settings, remoteSettings, {
        ...context,
        endpointUrl: remoteSettings.endpointUrl,
        authenticatedSessionReady: true,
        disclosureAccepted: false,
      }),
    ).toBe(false);
    expect(
      canRunLocalDeepSeekHarness(
        { ...settings, privacyMode: 'local-only' },
        remoteSettings,
        {
          ...context,
          endpointUrl: remoteSettings.endpointUrl,
          authenticatedSessionReady: true,
          disclosureAccepted: true,
        },
      ),
    ).toBe(false);
    expect(
      canRunLocalDeepSeekHarness(
        settings,
        { ...remoteSettings, endpointUrl: context.endpointUrl },
        context,
      ),
    ).toBe(true);
    expect(
      canRunLocalDeepSeekHarness(
        { ...settings, joyCodeEngine: 'cloud-openrouter' },
        {
          endpointUrl: context.endpointUrl,
          modelId: 'deepseek-chat',
          apiKey: 'local-key',
        },
        context,
      ),
    ).toBe(false);
  });
});
