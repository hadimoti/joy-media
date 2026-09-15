import { describe, expect, it } from 'vitest';
import {
  cloneJoyAgentRunEvent,
  isAllowedJoyAgentRunTransition,
  isJoyAgentRunEvent,
  isNextEvent,
  isTerminalJoyAgentRunState,
  type JoyAgentRunEvent,
  type RunScope,
} from './run-events.js';

const scope = (overrides: Partial<RunScope> = {}): RunScope => ({
  projectId: 'project-1',
  runId: 'run-1',
  epoch: 2,
  seq: 4,
  ...overrides,
});

const event = (overrides: Partial<JoyAgentRunEvent> = {}): JoyAgentRunEvent => ({
  version: 1,
  scope: scope(),
  state: 'preparing',
  at: '2026-09-06T00:00:00.000Z',
  ...overrides,
});

describe('JOY run event contract', () => {
  it('accepts only a strictly newer sequence inside the exact project/run/epoch scope', () => {
    const current = scope({ seq: 4 });
    expect(isNextEvent(current, scope({ seq: 5 }))).toBe(true);
    expect(isNextEvent(current, scope({ seq: 12 }))).toBe(true);
    expect(isNextEvent(current, scope({ seq: 4 }))).toBe(false);
    expect(isNextEvent(current, scope({ seq: 3 }))).toBe(false);
    expect(isNextEvent(current, scope({ projectId: 'project-2', seq: 5 }))).toBe(false);
    expect(isNextEvent(current, scope({ runId: 'run-2', seq: 5 }))).toBe(false);
    expect(isNextEvent(current, scope({ epoch: 3, seq: 5 }))).toBe(false);
  });

  it('keeps typed artifact references and display text bounded and secret-free', () => {
    const safe = event({
      state: 'preview-ready',
      changeSetVersion: 2,
      display: 'Prepared a title preview.',
      artifacts: [{ kind: 'prepared-change', id: 'change-set-2', version: 2 }],
    });
    expect(isJoyAgentRunEvent(safe)).toBe(true);
    const cloned = cloneJoyAgentRunEvent(safe);
    expect(cloned).toEqual(safe);
    expect(Object.isFrozen(cloned.scope)).toBe(true);
    expect(Object.isFrozen(cloned.artifacts)).toBe(true);

    expect(
      isJoyAgentRunEvent({
        ...safe,
        display: 'Bearer top-secret-provider-token',
      }),
    ).toBe(false);
    expect(
      isJoyAgentRunEvent({
        ...safe,
        artifacts: [
          { kind: 'prepared-change', id: 'AIzaAbcdefghijklmnopqrstuvwxyz12345', version: 2 },
        ],
      }),
    ).toBe(false);
    expect(isJoyAgentRunEvent({ ...safe, approvalId: 'forged' })).toBe(false);
    expect(isJoyAgentRunEvent({ ...safe, apiKey: 'forged' })).toBe(false);
  });

  it('has an explicit lifecycle graph and never resurrects terminal runs', () => {
    expect(isAllowedJoyAgentRunTransition('inspecting', 'preparing')).toBe(true);
    expect(isAllowedJoyAgentRunTransition('inspecting', 'completed')).toBe(true);
    expect(isAllowedJoyAgentRunTransition('preview-ready', 'awaiting-approval')).toBe(true);
    expect(isAllowedJoyAgentRunTransition('awaiting-approval', 'committing')).toBe(true);
    expect(isAllowedJoyAgentRunTransition('cancel-requested', 'verifying')).toBe(true);
    expect(isAllowedJoyAgentRunTransition('completed', 'inspecting')).toBe(false);
    expect(isAllowedJoyAgentRunTransition('failed', 'preparing')).toBe(false);
    expect(isTerminalJoyAgentRunState('completed')).toBe(true);
    expect(isTerminalJoyAgentRunState('interrupted')).toBe(true);
    expect(isTerminalJoyAgentRunState('awaiting-approval')).toBe(false);
  });
});
