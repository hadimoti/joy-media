import { describe, expect, it } from 'vitest';
import {
  AGENT_POLICY_STORAGE_KEY,
  DEFAULT_AGENT_POLICY,
  assertModelApplyPolicy,
  loadAgentPolicy,
  saveAgentPolicy,
  MODEL_APPLY_COST_GUARD,
} from '../agent-policy-settings.js';

describe('model proposal policy', () => {
  it('preserves an explicit deny-all policy through persistence', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    saveAgentPolicy(storage, { ...DEFAULT_AGENT_POLICY, allowedCapabilities: [] });
    expect(JSON.parse(values.get(AGENT_POLICY_STORAGE_KEY)!).allowedCapabilities).toEqual([]);
    const policy = loadAgentPolicy(storage);
    expect(policy.allowedCapabilities).toEqual([]);
    expect(() => assertModelApplyPolicy(policy)).toThrow('denies');
  });
  it('blocks suggest-only apply and reports unknown provider spend honestly', () => {
    expect(() =>
      assertModelApplyPolicy({ ...DEFAULT_AGENT_POLICY, executionMode: 'suggest-only' }),
    ).toThrow('Suggest-only');
    expect(() => assertModelApplyPolicy(DEFAULT_AGENT_POLICY)).not.toThrow();
    expect(MODEL_APPLY_COST_GUARD).toMatchObject({
      providerSpend: 'unknown',
      additionalApplyCostUsd: 0,
    });
  });
});
