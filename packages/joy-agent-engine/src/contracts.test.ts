import { describe, expect, it } from 'vitest';
import { JOY_AGENT_PHASES, JOY_AGENT_TASK_KINDS, parseJoyAgentSafeEvent } from './contracts.js';
import { DEFAULT_JOY_AGENT_LIMITS, clampJoyAgentLimits } from './limits.js';

const baseEvent = {
  protocolVersion: 1,
  runId: 'run-1',
  seq: 0,
  at: '2026-09-04T12:00:00.000Z',
  type: 'activity',
  phase: 'thinking',
  surface: 'joy-code',
  activityCode: 'agent.thinking',
} as const;

describe('JOY Agent contracts', () => {
  it('keeps protocol, phase, and task unions explicit', () => {
    expect(JOY_AGENT_PHASES).toEqual([
      'connecting',
      'thinking',
      'inspecting',
      'planning',
      'previewing',
      'awaiting-approval',
      'applying',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(JOY_AGENT_TASK_KINDS).toEqual([
      'joy-code-edit',
      'creative-brief',
      'asset-assist',
      'design-assist',
      'scene-3d-assist',
      'media-job-assist',
    ]);
  });

  it('requires protocol version, safe code, and monotonic sequence', () => {
    expect(parseJoyAgentSafeEvent(baseEvent).seq).toBe(0);
    expect(() => parseJoyAgentSafeEvent({ ...baseEvent, protocolVersion: 2 })).toThrow(
      'JOY_AGENT_INVALID_EVENT',
    );
    expect(() =>
      parseJoyAgentSafeEvent({ ...baseEvent, activityCode: 'free text from model' }),
    ).toThrow('JOY_AGENT_INVALID_EVENT');
    expect(() => parseJoyAgentSafeEvent({ ...baseEvent, seq: 0 }, 0)).toThrow(
      'JOY_AGENT_INVALID_EVENT',
    );
  });

  it('rejects credential, prompt, provider, reasoning, and DOM fields', () => {
    for (const key of [
      'apiKey',
      'authorization',
      'endpoint',
      'prompt',
      'rawRequest',
      'rawResponse',
      'reasoning',
      'selector',
    ]) {
      expect(() => parseJoyAgentSafeEvent({ ...baseEvent, [key]: 'sentinel' })).toThrow(
        'JOY_AGENT_INVALID_EVENT',
      );
    }
  });

  it('clamps requested limits down to immutable defaults', () => {
    const limits = clampJoyAgentLimits({
      maxSteps: 4,
      maxToolCalls: 999_999,
      wallTimeMs: 0,
      maxOutputTokens: 64,
    });
    expect(limits.maxSteps).toBe(4);
    expect(limits.maxToolCalls).toBe(DEFAULT_JOY_AGENT_LIMITS.maxToolCalls);
    expect(limits.wallTimeMs).toBe(DEFAULT_JOY_AGENT_LIMITS.wallTimeMs);
    expect(limits.maxOutputTokens).toBe(64);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(DEFAULT_JOY_AGENT_LIMITS)).toBe(true);
  });
});
