import { describe, expect, it } from 'vitest';
import {
  AGENT_POLICY_STORAGE_KEY,
  DEFAULT_AGENT_POLICY,
  DEFAULT_MAX_COST_PER_RUN_USD,
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

  it('starts a fresh install with a small cost limit per run', () => {
    // Ten dollars per run was too high for a first run (OB-15d).
    expect(DEFAULT_MAX_COST_PER_RUN_USD).toBe(0.5);
    expect(DEFAULT_AGENT_POLICY.maxCostPerRunUsd).toBe(0.5);
    expect(loadAgentPolicy(storage()).maxCostPerRunUsd).toBe(0.5);
  });

  it('keeps a cost limit the owner saved, whatever it is', () => {
    // Only the default changes. A limit that was saved is the owner's own.
    const store = storage();
    saveAgentPolicy(store, { ...DEFAULT_AGENT_POLICY, maxCostPerRunUsd: 10 });

    expect(loadAgentPolicy(store).maxCostPerRunUsd).toBe(10);

    const half = storage();
    saveAgentPolicy(half, { ...DEFAULT_AGENT_POLICY, maxCostPerRunUsd: 0.5 });

    expect(loadAgentPolicy(half).maxCostPerRunUsd).toBe(0.5);
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
      workerPreference: 'browser-worker',
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
