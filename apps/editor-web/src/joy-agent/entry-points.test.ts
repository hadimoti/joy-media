import { describe, expect, it, vi } from 'vitest';
import { JOY_AGENT_ENTRY_POINTS, runCreativeBriefTask, runJoyAgentTask } from './entry-points.js';
import type { JoyAgentEngineClient, JoyAgentRunIterator } from './engine-client.js';
import type { HostRpcMethods } from './host-rpc.js';
import {
  JOY_AGENT_PROTOCOL_VERSION,
  type JoyAgentPreparedProposal,
  type JoyAgentSafeEvent,
} from './protocol.js';

function fakeClient(events: readonly JoyAgentSafeEvent[]): JoyAgentEngineClient {
  return {
    configure: vi.fn(),
    testConnection: vi.fn(),
    probeMediaCapabilities: vi.fn(),
    startRun: vi.fn(() => fakeRunIterator(events)),
    cancel: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    getStatus: vi.fn(),
    getMediaCapabilities: vi.fn(),
    registerObservationReviewLease: vi.fn(),
    sendApprovedImageObservation: vi.fn(),
  };
}

function fakeRunIterator(events: readonly JoyAgentSafeEvent[]): JoyAgentRunIterator {
  return Object.assign(
    (async function* () {
      yield* events;
    })(),
    { run: { runId: 'run-1', epoch: 1 } },
  );
}

const event = (phase: JoyAgentSafeEvent['phase'], extra: Partial<JoyAgentSafeEvent> = {}) => ({
  protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
  runId: 'run-1',
  runEpoch: 1,
  seq: 1,
  at: '2026-09-04T00:00:00.000Z',
  phase,
  ...extra,
});

const host = { methods: {} as HostRpcMethods };

describe('JOY Agent entry points', () => {
  it('keeps an exhaustive task inventory with a target and policy capability', () => {
    expect(new Set(JOY_AGENT_ENTRY_POINTS.map((item) => item.id)).size).toBe(
      JOY_AGENT_ENTRY_POINTS.length,
    );
    for (const item of JOY_AGENT_ENTRY_POINTS) {
      expect(item.taskKind).toBeTruthy();
      expect(item.panelId).toBeTruthy();
      expect(item.sectionId).toBeTruthy();
      expect(item.capability).toBeTruthy();
    }
  });

  it('requires a trusted host before any structured entry point reaches the Worker', async () => {
    const client = fakeClient([]);
    await expect(
      runJoyAgentTask({
        client,
        taskKind: 'effects',
        prompt: 'make it softer',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'host-required' });
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it('returns a completed answer through the shared engine client without forwarding structured context', async () => {
    const client = fakeClient([
      event('thinking'),
      event('completed', { result: { kind: 'answer', text: 'Done' } }),
    ]);
    const seen: JoyAgentSafeEvent[] = [];
    const result = await runJoyAgentTask({
      client,
      host,
      taskKind: 'effects',
      prompt: 'make it softer',
      baseRevision: 'rev-1',
      context: { ignored: true },
      onEvent: (next) => seen.push(next),
    });
    expect(result.phase).toBe('completed');
    expect(result.result).toEqual({ kind: 'answer', text: 'Done' });
    expect(seen).toHaveLength(2);
    const [request, receivedHost] = vi.mocked(client.startRun).mock.calls[0] ?? [];
    expect(request).toMatchObject({
      taskKind: 'effects',
      baseRevision: 'rev-1',
      mode: 'tool-loop',
    });
    expect(request).not.toHaveProperty('context');
    expect(receivedHost).toBe(host);
  });

  it('hands a structured opaque preview to the awaiting-approval terminal', async () => {
    const proposal: JoyAgentPreparedProposal = {
      summary: 'Soften the color grade',
      baseRevision: 'rev-1',
      changeSetId: 'change-set-1',
      operationDigest: 'a'.repeat(64),
      bindingDigest: 'b'.repeat(64),
      operationCount: 1,
    };
    const seen: JoyAgentSafeEvent[] = [];
    const result = await runJoyAgentTask({
      client: fakeClient([
        event('previewing', { proposal }),
        event('awaiting-approval', { message: 'Review before applying' }),
      ]),
      host,
      taskKind: 'effects',
      prompt: 'make it softer',
      baseRevision: 'rev-1',
      onEvent: (next) => seen.push(next),
    });

    expect(result).toMatchObject({
      phase: 'awaiting-approval',
      message: 'Review before applying',
      proposal,
    });
    expect(result.proposal).not.toBe(proposal);
    expect('operations' in (result.proposal ?? {})).toBe(false);
    expect(seen.map((next) => next.phase)).toEqual(['previewing', 'awaiting-approval']);
  });

  it('fails closed when a structured run requests approval without a prepared preview', async () => {
    await expect(
      runJoyAgentTask({
        client: fakeClient([event('awaiting-approval')]),
        host,
        taskKind: 'effects',
        prompt: 'make it softer',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('fails closed when a model task fails, is cancelled, or includes a credential-shaped prompt', async () => {
    await expect(
      runJoyAgentTask({
        client: fakeClient([event('failed', { message: 'provider unavailable' })]),
        host,
        taskKind: 'audio',
        prompt: 'clean it',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'failed' });
    await expect(
      runJoyAgentTask({
        client: fakeClient([event('cancelled')]),
        host,
        taskKind: 'audio',
        prompt: 'clean it',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    const client = fakeClient([]);
    await expect(
      runJoyAgentTask({
        client,
        host,
        taskKind: 'joy-code',
        prompt: 'use apiKey=sk-123456789012345678901234',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it('keeps the Creative Brief entry point explicitly plan-only with bounded context', async () => {
    await expect(
      runCreativeBriefTask({
        client: fakeClient([event('completed', { result: { schemaVersion: 1 } })]),
        projectId: 'project-1',
        revisionId: 'rev-1',
        request: 'improve it',
        context: { projectId: 'project-1', revision: 'rev-1' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });
});
