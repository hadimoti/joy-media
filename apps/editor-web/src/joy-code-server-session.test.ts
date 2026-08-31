import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { CreativeBriefV1, JoyCodePlanProposalV1 } from '@joy-media/agent-tools';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import { JoyCodeServerSession } from './joy-code-server-session.js';

const project: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'p',
  title: 'P',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  rootCompositionId: 'c',
  settings: { defaultLocale: 'en' },
  compositions: {
    c: {
      id: 'c',
      name: 'C',
      width: 1920,
      height: 1080,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1_000_000,
      background: '#00000000',
      tracks: [],
    },
  },
  assets: {},
  variables: {},
  markers: [],
  visualObjects: {},
  captionDocuments: {},
  pluginData: {},
};
const binding: ControlPlaneProjectBinding = {
  editorProjectId: 'p',
  controlPlaneProjectId: 'cp',
  title: 'P',
};
const storage: BrowserKeyValueStore = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

describe('Joy Code server session', () => {
  it('invokes the local planner and skips cloud sync', async () => {
    let syncCalls = 0;
    const proposal = {
      schemaVersion: 1,
      goal: 'local plan',
      summary: 'local',
      operations: [],
      assumptions: [],
      blockedBy: [],
      requiresHumanDecision: [],
      planId: 'local-plan',
      projectId: 'p',
      snapshotRevisionId: 'r',
      createdAt: '2026-09-01T00:00:00.000Z',
      consentVersion: 'local-deepseek-harness-v1',
      catalogVersion: 'joy-code-catalog-v1',
      provenance: {
        actor: 'joy-code-client',
        adapterName: 'deepseek-harness-joy-code-v1',
        modelId: 'deepseek-chat',
      },
    } satisfies JoyCodePlanProposalV1;
    const session = new JoyCodeServerSession({
      binding,
      document: project,
      revisionId: 'r',
      storage,
      syncProjectDocument: async () => {
        syncCalls += 1;
        return { projectId: 'cp', revisionId: 'r' };
      },
      joyCodeTransport: async () => {
        throw new Error('cloud path must not run');
      },
      localJoyCodePlanner: async () => proposal,
    });
    const result = await session.plan('local', { clipIds: [] });
    expect(result).toMatchObject({ kind: 'success', proposal });
    expect(syncCalls).toBe(0);
  });

  it('returns parity failure locally and does not call sync or provider', async () => {
    let calls = 0;
    const session = new JoyCodeServerSession({
      binding,
      document: project,
      revisionId: 'r',
      storage,
      syncProjectDocument: async () => {
        calls += 1;
        return { projectId: 'cp', revisionId: 'r' };
      },
      joyCodeTransport: async () => {
        calls += 1;
        throw new Error('network');
      },
    });
    const result = await session.plan('trim', { clipIds: [] }, 'wrong-project');
    expect(result.kind).toBe('parity-failure');
    expect(calls).toBe(0);
  });
  it('exposes cancellation through the injected planner signal', async () => {
    const session = new JoyCodeServerSession({
      binding,
      document: project,
      revisionId: 'r',
      storage,
      syncProjectDocument: async () => ({ projectId: 'cp', revisionId: 'r' }),
      joyCodeTransport: async (_id, _request, signal) => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return Promise.reject(new Error('unexpected'));
      },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await session.plan('trim', { clipIds: [] }, 'p', controller.signal);
    expect(result.kind).toBe('cancelled');
  });

  it('forwards an explicitly handed-off Creative Brief to the planner transport', async () => {
    const brief = { schemaVersion: 1, projectId: 'p', snapshotRevisionId: 'r' } as CreativeBriefV1;
    let received: CreativeBriefV1 | undefined;
    const session = new JoyCodeServerSession({
      binding,
      document: project,
      revisionId: 'r',
      storage,
      syncProjectDocument: async () => ({ projectId: 'cp', revisionId: 'r' }),
      joyCodeTransport: async (_id, request) => {
        received = request.creativeBrief;
        throw new Error('stop after capture');
      },
    });
    const result = await session.plan('trim', { clipIds: [] }, undefined, undefined, brief);
    expect(result.kind).toBe('plan-failure');
    expect(received).toBe(brief);
  });
});
