import { describe, expect, it } from 'vitest';
import {
  AGENT_POLICY_STORAGE_KEY,
  clampQualityCheckBudget,
  DEFAULT_AGENT_POLICY,
  DEFAULT_MAX_COST_PER_RUN_USD,
  DEFAULT_QUALITY_CHECK,
  LEGACY_AGENT_SETTINGS_STORAGE_KEY,
  loadAgentPolicy,
  QUALITY_CHECK_BUDGET_BOUNDS,
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

  it('keeps the established $10 cost threshold on a fresh install', () => {
    expect(DEFAULT_MAX_COST_PER_RUN_USD).toBe(10);
    expect(DEFAULT_AGENT_POLICY.maxCostPerRunUsd).toBe(10);
    expect(loadAgentPolicy(storage()).maxCostPerRunUsd).toBe(10);
  });

  it('keeps a cost limit the owner saved, whatever it is', () => {
    // A limit that was saved is the owner's own, whatever it is.
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

  it('keeps every existing default as it was', () => {
    expect(DEFAULT_AGENT_POLICY).toMatchObject({
      version: 2,
      executionMode: 'preview-and-approve',
      maxCostPerRunUsd: 10,
      privacyMode: 'ask-before-remote',
      workerPreference: 'browser-worker',
      mediaProvider: 'Approved provider',
      livePreview: true,
    });
  });
});

describe('the quality check settings (T-B05)', () => {
  it('starts at the ADR-0045 defaults on a fresh install', () => {
    expect(DEFAULT_QUALITY_CHECK).toEqual({
      framesPerCheck: 12,
      framesPerRun: 16,
      fixRounds: 3,
      neverSendFramesToRemoteModel: false,
    });
    expect(loadAgentPolicy(storage()).qualityCheck).toEqual(DEFAULT_QUALITY_CHECK);
  });

  it('loads a policy saved before the quality check existed with the ADR defaults', () => {
    const store = storage();
    store.setItem(
      AGENT_POLICY_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        executionMode: 'auto-apply-low-risk',
        allowedCapabilities: ['timeline.read', 'timeline.write'],
        maxCostPerRunUsd: 4,
        privacyMode: 'local-only',
        workerPreference: 'browser-worker',
        mediaProvider: 'Approved provider',
        livePreview: false,
      }),
    );

    const loaded = loadAgentPolicy(store);

    expect(loaded.qualityCheck).toEqual(DEFAULT_QUALITY_CHECK);
    // The rest of the saved policy is read as it was saved.
    expect(loaded).toMatchObject({
      executionMode: 'auto-apply-low-risk',
      maxCostPerRunUsd: 4,
      privacyMode: 'local-only',
      livePreview: false,
    });
  });

  it('fills in only the keys a partly saved quality check does not have', () => {
    const store = storage();
    store.setItem(
      AGENT_POLICY_STORAGE_KEY,
      JSON.stringify({ version: 2, qualityCheck: { fixRounds: 2 } }),
    );

    expect(loadAgentPolicy(store).qualityCheck).toEqual({
      ...DEFAULT_QUALITY_CHECK,
      fixRounds: 2,
    });
  });

  it('keeps the saved values after a restart', () => {
    const before = storage();
    saveAgentPolicy(before, {
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: {
        framesPerCheck: 8,
        framesPerRun: 30,
        fixRounds: 1,
        neverSendFramesToRemoteModel: true,
      },
    });

    // A restart reads the same stored text back into a new store.
    const afterRestart = storage();
    afterRestart.setItem(
      AGENT_POLICY_STORAGE_KEY,
      before.values.get(AGENT_POLICY_STORAGE_KEY) ?? '',
    );

    expect(loadAgentPolicy(afterRestart).qualityCheck).toEqual({
      framesPerCheck: 8,
      framesPerRun: 30,
      fixRounds: 1,
      neverSendFramesToRemoteModel: true,
    });
  });

  it('keeps each budget inside its bounds, whole numbers only', () => {
    expect(clampQualityCheckBudget('framesPerCheck', 40)).toBe(16);
    expect(clampQualityCheckBudget('framesPerCheck', 0)).toBe(1);
    expect(clampQualityCheckBudget('framesPerCheck', 2.6)).toBe(3);
    expect(clampQualityCheckBudget('framesPerRun', 5)).toBe(12);
    expect(clampQualityCheckBudget('framesPerRun', 99)).toBe(48);
    expect(clampQualityCheckBudget('fixRounds', 9)).toBe(3);
    expect(clampQualityCheckBudget('fixRounds', 0)).toBe(1);
    expect(clampQualityCheckBudget('fixRounds', Number.NaN)).toBe(
      QUALITY_CHECK_BUDGET_BOUNDS.fixRounds.default,
    );
    expect(clampQualityCheckBudget('framesPerRun', undefined)).toBe(16);
  });

  it('brings a saved out-of-range budget back inside its bounds when it is loaded', () => {
    const store = storage();
    store.setItem(
      AGENT_POLICY_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        qualityCheck: { framesPerCheck: 99, framesPerRun: 1, fixRounds: 'many' },
      }),
    );

    expect(loadAgentPolicy(store).qualityCheck).toEqual({
      framesPerCheck: 16,
      framesPerRun: 12,
      fixRounds: 3,
      neverSendFramesToRemoteModel: false,
    });
  });

  it('keeps the never-send switch off unless it was turned on', () => {
    const store = storage();
    store.setItem(AGENT_POLICY_STORAGE_KEY, JSON.stringify({ version: 2, qualityCheck: {} }));
    expect(loadAgentPolicy(store).qualityCheck.neverSendFramesToRemoteModel).toBe(false);

    store.setItem(
      AGENT_POLICY_STORAGE_KEY,
      JSON.stringify({ version: 2, qualityCheck: { neverSendFramesToRemoteModel: 'yes' } }),
    );
    expect(loadAgentPolicy(store).qualityCheck.neverSendFramesToRemoteModel).toBe(false);
  });
});
