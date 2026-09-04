import { describe, expect, it, vi } from 'vitest';
import { JOY_AGENT_ENTRY_POINTS, runCreativeBriefTask, runJoyAgentTask } from './entry-points.js';
import type { JoyAgentEngineClient } from './engine-client.js';
import type { JoyAgentSafeEvent } from './protocol.js';

function fakeClient(events: readonly JoyAgentSafeEvent[]): JoyAgentEngineClient {
  return {
    configure: vi.fn(),
    testConnection: vi.fn(),
    startRun: vi.fn(() =>
      (async function* () {
        yield* events;
      })(),
    ),
    cancel: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    getStatus: vi.fn(),
  };
}

const event = (phase: JoyAgentSafeEvent['phase'], extra: Partial<JoyAgentSafeEvent> = {}) => ({
  protocolVersion: 1 as const,
  runId: 'run-1',
  seq: 1,
  at: '2026-09-04T00:00:00.000Z',
  phase,
  ...extra,
});

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

  it('uses the shared engine client and forwards safe events', async () => {
    const client = fakeClient([event('thinking'), event('completed')]);
    const seen: JoyAgentSafeEvent[] = [];
    const started: string[] = [];
    const result = await runJoyAgentTask({
      client,
      taskKind: 'effects',
      prompt: 'make it softer',
      baseRevision: 'rev-1',
      onEvent: (next) => seen.push(next),
      onRunStart: (runId) => started.push(runId),
    });
    expect(result.phase).toBe('completed');
    expect(seen).toHaveLength(2);
    expect(started).toHaveLength(1);
    expect(started[0]).toContain('effects-');
    expect(client.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskKind: 'effects', baseRevision: 'rev-1', mode: 'tool-loop' }),
    );
  });

  it('fails closed when a model task fails or is cancelled', async () => {
    await expect(
      runJoyAgentTask({
        client: fakeClient([event('failed', { message: 'provider unavailable' })]),
        taskKind: 'audio',
        prompt: 'clean it',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'failed' });
    await expect(
      runJoyAgentTask({
        client: fakeClient([event('cancelled')]),
        taskKind: 'audio',
        prompt: 'clean it',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('does not start the Worker for local-only or credential-shaped requests', async () => {
    const client = fakeClient([]);
    const onRunStart = vi.fn();
    await expect(
      runJoyAgentTask({
        client,
        taskKind: 'joy-code',
        prompt: 'trim the intro',
        baseRevision: 'rev-1',
        allowRemote: false,
        onRunStart,
      }),
    ).rejects.toMatchObject({ code: 'remote-disabled' });
    await expect(
      runJoyAgentTask({
        client,
        taskKind: 'joy-code',
        prompt: 'use apiKey=sk-123456789012345678901234',
        baseRevision: 'rev-1',
      }),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(client.startRun).not.toHaveBeenCalled();
    expect(onRunStart).not.toHaveBeenCalled();
  });

  it('validates Creative Brief results and rejects invalid or stale data', async () => {
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
