import { describe, expect, it, vi } from 'vitest';
import { createDirectorVerificationReport } from './director-verifier.js';
import type { CreativeSkillHostPrimitives } from './creative-skill-host-adapter.js';
import {
  JOY_AGENT_ENTRY_POINTS,
  listCreativeSkills,
  runCreativeBriefTask,
  runCreativeSkill,
  runJoyAgentTask,
  runScopedCreativeSkillToolLoop,
} from './entry-points.js';
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

  it('lists R1 recipes with honest availability from verified seams only', () => {
    const byId = new Map(listCreativeSkills().map((entry) => [entry.skill.id, entry]));
    expect(byId.get('build-rough-cut')?.available).toBe(true);
    expect(byId.get('find-moment')?.available).toBe(false);
    expect(byId.get('audio-balance')?.available).toBe(false);
    expect(byId.get('title-and-caption-polish')?.available).toBe(false);
    // With the observation bridge absent, source-observation recipes withhold.
    const noBridge = new Map(
      listCreativeSkills({
        projectContext: true,
        canonicalPrepare: true,
        preview: true,
        approval: true,
        observationBridge: false,
        boundedSourceMoment: false,
        transcriptEvidence: false,
        audioAnalysis: false,
        compositionCapture: true,
        encodedOutputVerification: true,
        audioMix: false,
        rtlTextReadback: false,
      }).map((entry) => [entry.skill.id, entry]),
    );
    expect(noBridge.get('build-rough-cut')?.available).toBe(false);
    expect(noBridge.get('creative-brief')?.available).toBe(true);
  });

  it('runs a recipe through the shared runner with no apply and stops at ready-for-approval', async () => {
    const events: string[] = [];
    const primitives: CreativeSkillHostPrimitives = {
      readProjectContext: vi.fn(async () => ({ summary: 'Read overview, tracks and clips.' })),
      observeSources: vi.fn(async () => ({
        evidenceIds: ['evidence-a'],
        coverageSummary: 'Sampled 8 of 240 source frames.',
        coverageComplete: false,
      })),
      prepareChange: vi.fn(async () => ({
        kind: 'prepared' as const,
        changeSetId: 'change-set-1',
        operationDigest: 'a'.repeat(64),
        operationCount: 2,
        repairAttempts: 1,
        summary: 'Prepared two timeline operations.',
      })),
      stagePreview: vi.fn(async () => ({
        previewId: 'preview-1',
        rendererAcknowledged: true,
        summary: 'Before/after preview acknowledged.',
      })),
      verifyDeliverable: vi.fn(async () => ({
        report: createDirectorVerificationReport({
          projectId: 'project-1',
          revision: 'revision-1',
          checks: [
            {
              id: 'structural-1',
              method: 'structural',
              status: 'passed',
              evidenceIds: ['evidence-a'],
              summary: 'Project state matches.',
            },
          ],
        }),
        summary: 'Structural only.',
      })),
    };
    const result = await runCreativeSkill({
      skillId: 'build-rough-cut',
      scope: { projectId: 'project-1', runId: 'run-1', epoch: 1, revision: 'revision-1' },
      primitives,
      isAuthorityCurrent: () => true,
      onEvent: (e) => events.push(`${e.state}:${e.phase}`),
    });
    expect(result.kind).toBe('ready-for-approval');
    expect(result.artifacts.map((a) => a.kind)).toEqual([
      'context',
      'evidence',
      'prepared-change',
      'preview',
    ]);
    expect(events).toContain('completed:preview');
    expect(primitives.verifyDeliverable).not.toHaveBeenCalled();
  });

  it('maps a scoped recipe tool-loop terminal event to the recipe result shape', async () => {
    const proposal: JoyAgentPreparedProposal = {
      summary: 'Trim the intro',
      baseRevision: 'rev-1',
      changeSetId: 'change-set-9',
      operationDigest: 'c'.repeat(64),
      bindingDigest: 'd'.repeat(64),
      operationCount: 3,
    };
    await expect(
      runScopedCreativeSkillToolLoop({
        client: fakeClient([
          event('previewing', { proposal }),
          event('awaiting-approval', { message: 'review' }),
        ]),
        host,
        prompt: 'prepare a rough cut',
        baseRevision: 'rev-1',
      }),
    ).resolves.toEqual({
      kind: 'prepared',
      changeSetId: 'change-set-9',
      operationDigest: 'c'.repeat(64),
      operationCount: 3,
      repairAttempts: 0,
    });

    await expect(
      runScopedCreativeSkillToolLoop({
        client: fakeClient([
          event('completed', { result: { kind: 'answer', text: 'Flash at 1.5s' } }),
        ]),
        host,
        prompt: 'find the flash',
        baseRevision: 'rev-1',
      }),
    ).resolves.toEqual({ kind: 'answer', text: 'Flash at 1.5s' });

    await expect(
      runScopedCreativeSkillToolLoop({
        client: fakeClient([event('failed', { message: 'provider unavailable' })]),
        host,
        prompt: 'prepare a rough cut',
        baseRevision: 'rev-1',
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
  });
});
