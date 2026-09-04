import { describe, expect, it } from 'vitest';
import {
  AGENT_POLICY_STORAGE_KEY,
  DEFAULT_AGENT_POLICY,
  LEGACY_AGENT_SETTINGS_STORAGE_KEY,
  loadAgentPolicy,
  saveAgentPolicy,
} from './agent-policy-settings.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe('AgentPolicyPreferences v2', () => {
  it('loads safe defaults when no policy exists', () => {
    expect(loadAgentPolicy(storage())).toEqual(DEFAULT_AGENT_POLICY);
  });

  it('persists policy without any provider connection fields', () => {
    const store = storage();
    saveAgentPolicy(store, DEFAULT_AGENT_POLICY);
    const serialized = store.values.get(AGENT_POLICY_STORAGE_KEY);
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('baseUrl');
    expect(serialized).not.toContain('modelId');
    expect(serialized).not.toContain('deepSeek');
    expect(store.values.has(LEGACY_AGENT_SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('migrates only editing policy and removes the complete legacy record', () => {
    const store = storage();
    store.setItem(
      LEGACY_AGENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeHost: 'kilocode',
        executionMode: 'suggest-only',
        maxCostPerRunUsd: 2.5,
        privacyMode: 'local-only',
        workerPreference: 'any-approved',
        mediaProvider: 'media-test',
        joyCodeEngine: 'local-deepseek-harness',
        deepSeekHarnessEndpoint: 'https://provider.invalid/v1',
        deepSeekHarnessModel: 'provider/model',
        sentinel: 'do-not-retain',
      }),
    );

    const migrated = loadAgentPolicy(store);

    expect(migrated).toMatchObject({
      version: 2,
      executionMode: 'suggest-only',
      maxCostPerRunUsd: 2.5,
      privacyMode: 'local-only',
      workerPreference: 'any-approved',
      mediaProvider: 'media-test',
      livePreview: true,
    });
    expect(store.values.has(LEGACY_AGENT_SETTINGS_STORAGE_KEY)).toBe(false);
    expect(store.values.get(AGENT_POLICY_STORAGE_KEY)).not.toContain('provider.invalid');
    expect(store.values.get(AGENT_POLICY_STORAGE_KEY)).not.toContain('sentinel');
    expect(Object.keys(migrated)).not.toContain('activeHost');
    expect(Object.keys(migrated)).not.toContain('joyCodeEngine');
  });
});
