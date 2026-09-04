import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_AGENT_PRESENCE,
  createAgentPresenceStore,
  reduceAgentPresence,
  type JoyAgentPresenceEvent,
} from './agent-presence.js';

const target = { panelId: 'timeline' as const, sectionId: 'timeline' };
const event = (overrides: Partial<JoyAgentPresenceEvent> = {}): JoyAgentPresenceEvent => ({
  protocolVersion: 1,
  runId: 'run-1',
  seq: 0,
  at: '2026-09-04T00:00:00.000Z',
  revision: 4,
  kind: 'activity',
  phase: 'thinking',
  targets: [target],
  ...overrides,
});

describe('JOY agent presence reducer', () => {
  it('accepts one monotonic run and ignores stale, wrong-run, and terminal events', () => {
    const first = reduceAgentPresence(EMPTY_AGENT_PRESENCE, event());
    expect(first.runId).toBe('run-1');
    expect(first.seq).toBe(0);
    expect(reduceAgentPresence(first, event({ seq: 0, phase: 'planning' }))).toBe(first);
    expect(reduceAgentPresence(first, event({ seq: 1, runId: 'run-2' }))).toBe(first);
    expect(reduceAgentPresence(first, event({ seq: 1, revision: 3 }))).toBe(first);

    const failed = reduceAgentPresence(
      first,
      event({ seq: 1, kind: 'failed', phase: 'failed', errorCode: 'JOY_AGENT_TIMEOUT' }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.targets).toHaveLength(0);
    expect(reduceAgentPresence(failed, event({ seq: 2, phase: 'thinking' }))).toBe(failed);
  });

  it('keeps awaiting approval stable and only accepts measured progress', () => {
    const store = createAgentPresenceStore();
    store.beginRun('run-approval', 2);
    store.dispatch(
      event({
        runId: 'run-approval',
        seq: 1,
        revision: 2,
        kind: 'approval-required',
        phase: 'awaiting-approval',
        progress: { current: 1, total: 3 },
      }),
    );
    expect(store.getState().phase).toBe('awaiting-approval');
    expect(store.getState().progress).toEqual({ current: 1, total: 3 });
    store.dispatch(
      event({
        runId: 'run-approval',
        seq: 2,
        revision: 2,
        kind: 'progress',
        phase: 'applying',
        progress: { current: 4, total: 3 },
      }),
    );
    expect(store.getState().progress).toBeUndefined();
  });

  it('clears preview on invalidation and after completed handoff', () => {
    const store = createAgentPresenceStore();
    store.beginRun('run-preview', 10);
    store.dispatch(
      event({
        runId: 'run-preview',
        seq: 1,
        revision: 10,
        kind: 'preview',
        phase: 'previewing',
        preview: { revision: 10, summaryCode: 'timeline-diff', targetCount: 1 },
      }),
    );
    expect(store.getState().preview).toBeDefined();
    store.invalidatePreview(11);
    expect(store.getState().preview).toBeUndefined();
    store.dispatch(
      event({
        runId: 'run-preview',
        seq: 2,
        revision: 11,
        kind: 'completed',
        phase: 'completed',
        targets: [target],
      }),
    );
    expect(store.getState().terminalTarget).toEqual(target);
    store.completeHandoff();
    expect(store.getState()).toEqual(EMPTY_AGENT_PRESENCE);
  });

  it('notifies selector subscribers only when their slice changes', () => {
    const store = createAgentPresenceStore();
    store.beginRun('run-selectors', 1);
    const timeline = store.getPanelPresence('timeline');
    const listener = vi.fn();
    store.subscribeSelector(() => store.getPanelPresence('timeline'), listener);
    store.dispatch(
      event({
        runId: 'run-selectors',
        seq: 1,
        revision: 1,
        targets: [{ panelId: 'agent', sectionId: 'composer' }],
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    expect(store.getPanelPresence('timeline')).toBe(timeline);
    store.dispatch(
      event({
        runId: 'run-selectors',
        seq: 2,
        revision: 1,
        targets: [target],
      }),
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
