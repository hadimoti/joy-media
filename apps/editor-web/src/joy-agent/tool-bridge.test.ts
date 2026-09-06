import { describe, expect, it, vi } from 'vitest';
import type {
  HostRpcHandlerContext,
  HostRpcJson,
  HostRpcMethod,
  HostRpcMethods,
} from './host-rpc.js';
import {
  createJoyAgentHostRpcMethods,
  createJoyAgentHostRpcMethodsForSnapshot,
  type JoyAgentObservationToolAdapter,
  type JoyAgentPreparedHostResult,
} from './tool-bridge.js';
import { createJoyAgentPagedContext } from './context-snapshot.js';

const digest = 'a'.repeat(64);
const bindingDigest = 'b'.repeat(64);

function handlerContext(): HostRpcHandlerContext {
  return {
    run: { runId: 'run-1', epoch: 1 },
    requestId: 'request-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
  };
}

function method(
  methods: HostRpcMethods,
  name:
    | 'read_project_context'
    | 'validate_proposal'
    | 'media_describe'
    | 'media_observe'
    | 'media_frames'
    | 'media_transcript'
    | 'evidence_read'
    | 'evidence_coverage',
): HostRpcMethod<HostRpcJson, HostRpcJson> {
  return methods[name] as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
}

async function invoke(
  methods: HostRpcMethods,
  name:
    | 'read_project_context'
    | 'validate_proposal'
    | 'media_describe'
    | 'media_observe'
    | 'media_frames'
    | 'media_transcript'
    | 'evidence_read'
    | 'evidence_coverage',
  args: HostRpcJson,
): Promise<HostRpcJson> {
  const target = method(methods, name);
  return target.parseResult(await target.execute(target.parseArgs(args), handlerContext()));
}

function preparedResult(): JoyAgentPreparedHostResult {
  return {
    summary: 'A safe preview is ready',
    baseRevision: 'revision-1',
    changeSetId: 'change-set-1',
    operationDigest: digest,
    bindingDigest,
    operationCount: 1,
  };
}

function unavailableObservationAdapter(): JoyAgentObservationToolAdapter {
  const unavailable = (): never => {
    throw new Error('not reached');
  };
  return {
    isAuthorityCurrent: () => true,
    describe: unavailable,
    observe: unavailable,
    frames: unavailable,
    transcript: unavailable,
    readEvidence: unavailable,
    coverage: unavailable,
  };
}

function safeEntityReference() {
  return {
    version: 1,
    projectId: 'project-1',
    executionId: 'execution-1',
    resultRevision: 'revision-previous',
    entityId: 'title-1',
    entityKind: 'visual-text',
    label: 'Text layer',
  } as const;
}

describe('JOY Agent trusted host tool bridge', () => {
  it('keeps snapshot bridges legacy-only without observation and exposes all six observation methods with one', () => {
    const input = { projectId: 'project-1', revision: 'revision-1' };
    const withoutObservation = createJoyAgentHostRpcMethodsForSnapshot(input, () =>
      preparedResult(),
    );
    const withObservation = createJoyAgentHostRpcMethodsForSnapshot(
      input,
      () => preparedResult(),
      unavailableObservationAdapter(),
    );

    expect(Object.keys(withoutObservation).sort()).toEqual([
      'read_project_context',
      'validate_proposal',
    ]);
    expect(Object.keys(withObservation).sort()).toEqual([
      'evidence_coverage',
      'evidence_read',
      'media_describe',
      'media_frames',
      'media_observe',
      'media_transcript',
      'read_project_context',
      'validate_proposal',
    ]);
  });

  it('serves frozen pages beyond the compact model snapshot and supports track/title discovery', async () => {
    const input = {
      projectId: 'project-1',
      revision: 'revision-1',
      trackIds: Array.from({ length: 200 }, (_, index) => `track-${index}`),
      clips: Array.from({ length: 300 }, (_, index) => ({
        id: `clip-${index}`,
        trackId: `track-${index % 200}`,
        startUs: index,
        durationUs: 1,
      })),
      assets: Array.from({ length: 300 }, (_, index) => ({
        id: `asset-${index}`,
        kind: 'image',
        displayName: `Asset ${index}`,
      })),
      visualObjects: Array.from({ length: 200 }, (_, index) => ({
        id: `title-${index}`,
        kind: 'text',
        text: index === 176 ? 'Find this distinctive launch title' : `Title ${index}`,
        transform: { x: index },
        animatedProperties: ['opacity'],
      })),
    };
    const context = createJoyAgentPagedContext(input);
    const methods = createJoyAgentHostRpcMethods({
      context,
      prepareProposal: () => preparedResult(),
    });

    expect(context.snapshot.clips).toHaveLength(128);
    expect(context.snapshot.assets).toHaveLength(128);

    await expect(
      invoke(methods, 'read_project_context', {
        domain: 'clips',
        cursor: 128,
        pageSize: 2,
      }),
    ).resolves.toMatchObject({
      projectId: 'project-1',
      revision: 'revision-1',
      domain: 'clips',
      items: [{ id: 'clip-128' }, { id: 'clip-129' }],
      nextCursor: 130,
    });
    await expect(
      invoke(methods, 'read_project_context', {
        domain: 'assets',
        cursor: 256,
        pageSize: 2,
      }),
    ).resolves.toMatchObject({
      domain: 'assets',
      items: [{ id: 'asset-256' }, { id: 'asset-257' }],
    });
    await expect(
      invoke(methods, 'read_project_context', {
        domain: 'tracks',
        cursor: 128,
        pageSize: 2,
      }),
    ).resolves.toMatchObject({
      domain: 'tracks',
      items: [{ id: 'track-128' }, { id: 'track-129' }],
    });
    await expect(
      invoke(methods, 'read_project_context', {
        domain: 'titles',
        cursor: 0,
        pageSize: 4,
        query: 'DISTINCTIVE LAUNCH',
      }),
    ).resolves.toMatchObject({
      domain: 'titles',
      items: [{ id: 'title-176', text: 'Find this distinctive launch title' }],
    });
  });

  it('returns a bounded overview and independently cloned pages', async () => {
    const source = {
      projectId: 'project-1',
      revision: 'revision-1',
      clips: Array.from({ length: 300 }, (_, index) => ({
        id: `clip-${index}`,
        trackId: 'track-1',
        startUs: index,
        durationUs: 1,
      })),
      assets: [
        {
          id: 'asset-1',
          kind: 'image',
          displayName: 'Safe poster',
        },
      ],
      visualObjects: [
        {
          id: 'title-1',
          kind: 'text',
          text: 'Original title',
          transform: { x: 10 },
          animatedProperties: ['opacity'],
        },
      ],
    };
    const methods = createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext(source),
      prepareProposal: () => preparedResult(),
    });

    const overview = (await invoke(methods, 'read_project_context', {
      domain: 'overview',
      cursor: 0,
      pageSize: 1,
    })) as Record<string, unknown>;
    expect(overview).toMatchObject({
      projectId: 'project-1',
      revision: 'revision-1',
      clipCount: 300,
      assetCount: 1,
    });
    expect(overview).not.toHaveProperty('clips');
    expect(overview).not.toHaveProperty('assets');
    expect(JSON.stringify(overview)).not.toContain('Safe poster');

    const firstPage = (await invoke(methods, 'read_project_context', {
      domain: 'visual-objects',
      cursor: 0,
      pageSize: 1,
    })) as {
      items: Array<{ transform?: { x: number } }>;
    };
    firstPage.items[0]!.transform!.x = 999;
    const secondPage = (await invoke(methods, 'read_project_context', {
      domain: 'visual-objects',
      cursor: 0,
      pageSize: 1,
    })) as {
      items: Array<{ transform?: { x: number } }>;
    };
    expect(secondPage.items[0]).toMatchObject({ transform: { x: 10 } });
  });

  it('publishes only validator-gated fixed entity references in the overview', async () => {
    const reference = safeEntityReference();
    const context = createJoyAgentPagedContext({
      projectId: 'project-1',
      revision: 'revision-1',
      recentEntityReferences: [reference],
    });
    // The bridge must validate at publication time too, even if a caller
    // somehow hand-constructs an otherwise trusted context object.
    const methods = createJoyAgentHostRpcMethods({
      context: {
        ...context,
        snapshot: {
          ...context.snapshot,
          recentEntityReferences: [
            reference,
            { ...reference, label: 'apiKey=must-not-reach-the-worker' },
            { ...reference, projectId: 'other-project' },
          ] as never,
        },
      },
      prepareProposal: () => preparedResult(),
    });

    const overview = (await invoke(methods, 'read_project_context', {
      domain: 'overview',
      cursor: 0,
      pageSize: 1,
    })) as Record<string, unknown>;

    expect(overview.recentEntityReferences).toEqual([reference]);
    expect(JSON.stringify(overview)).not.toContain('apiKey');
    expect(JSON.stringify(overview)).not.toContain('other-project');
  });

  it('publishes receipt references bound to a distinct canonical timeline project', async () => {
    const reference = { ...safeEntityReference(), projectId: 'timeline-project-1' } as const;
    const context = createJoyAgentPagedContext({
      projectId: 'visual-project-1',
      entityReferenceProjectId: 'timeline-project-1',
      revision: 'revision-1',
      recentEntityReferences: [reference],
    });
    const methods = createJoyAgentHostRpcMethods({
      context,
      prepareProposal: () => preparedResult(),
    });

    await expect(
      invoke(methods, 'read_project_context', { domain: 'overview', cursor: 0, pageSize: 1 }),
    ).resolves.toMatchObject({ recentEntityReferences: [reference] });
  });

  it('maps canonical compiler failures to bounded repair diagnostics without leaking errors', async () => {
    const methods = createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext({ projectId: 'project-1', revision: 'revision-1' }),
      prepareProposal: () => {
        throw new Error('raw apiKey=must-never-reach-the-model');
      },
    });

    const pending = invoke(methods, 'validate_proposal', {
      summary: 'Move the opening clip',
      operations: [
        {
          id: 'move-clip',
          kind: 'timeline.moveClip',
          compositionId: 'composition-1',
          clipId: 'clip-1',
          sourceTrackId: 'track-1',
          targetTrackId: 'track-1',
          newStartUs: 500,
          dependsOn: [],
        },
      ],
    });
    await expect(pending).rejects.toMatchObject({
      diagnostic: {
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        retryable: true,
        field: 'operations',
        facts: { compilerCode: 'JOY_AGENT_CANONICAL_COMPILER_REJECTED' },
      },
    });
    await expect(pending).rejects.not.toThrow('apiKey');
  });

  it('binds metadata-only observation queries to the current host run without exposing a clear tool', async () => {
    const calls: Array<{
      readonly kind: string;
      readonly input: unknown;
      readonly authority: unknown;
    }> = [];
    const onObservationCompleted = vi.fn();
    const observation = {
      isAuthorityCurrent: () => true,
      describe: async (input: unknown, authority: unknown) => {
        calls.push({ kind: 'describe', input, authority });
        return {
          assetId: 'asset-1',
          assetDigest: 'c'.repeat(64),
          kind: 'video',
          durationUs: 10_000,
          streamCount: 1,
          transcriptAvailable: true,
        };
      },
      observe: async (input: unknown, authority: unknown) => {
        calls.push({ kind: 'observe', input, authority });
        return {
          observationId: 'observation-1',
          manifestId: 'manifest-1',
          mode: 'focus',
          range: { startUs: 100, endUs: 300 },
          status: 'running',
          intendedFrameCount: 2,
          decodedFrameCount: 0,
          omittedFrameCount: 0,
        };
      },
      frames: async (input: unknown, authority: unknown) => {
        calls.push({ kind: 'frames', input, authority });
        return {
          observationId: 'observation-1',
          items: [
            {
              id: 'source-frame:v1:asset-1:video-0:0',
              actualTimeUs: 100,
              durationUs: 33_333,
              presentationIndex: 0,
              width: 160,
              height: 90,
              cacheHit: false,
            },
          ],
          nextCursor: 1,
        };
      },
      transcript: async (input: unknown, authority: unknown) => {
        calls.push({ kind: 'transcript', input, authority });
        return {
          transcriptId: 'transcript-1',
          assetId: 'asset-1',
          language: 'en',
          range: { startUs: 100, endUs: 300 },
          wordCount: 1,
          contentAvailable: false,
          items: [
            {
              id: 'transcript-word-1',
              startUs: 120,
              endUs: 180,
              confidence: 0.9,
              speakerId: 'speaker-1',
            },
          ],
        };
      },
      readEvidence: async (input: unknown, authority: unknown) => {
        calls.push({ kind: 'readEvidence', input, authority });
        return {
          manifestId: 'manifest-1',
          pageIndex: 0,
          pageCount: 1,
          mode: 'focus',
          status: 'complete',
          intendedFrameIds: ['source-frame:v1:asset-1:video-0:0'],
          decodedFrameIds: ['source-frame:v1:asset-1:video-0:0'],
          submittedFrameIds: [],
          reviewedFrameIds: [],
          summary: {
            intendedFrameCount: 1,
            decodedFrameCount: 1,
            submittedFrameCount: 0,
            reviewedFrameCount: 0,
            exhaustiveInput: false,
            modelComprehensionGuaranteed: false,
          },
        };
      },
      coverage: async (input: unknown, authority: unknown) => {
        calls.push({ kind: 'coverage', input, authority });
        return {
          manifestId: 'manifest-1',
          mode: 'focus',
          status: 'complete',
          intendedFrameCount: 1,
          decodedFrameCount: 1,
          submittedFrameCount: 0,
          reviewedFrameCount: 0,
          exhaustiveInput: false,
          modelComprehensionGuaranteed: false,
        };
      },
    };
    const methods = createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext({ projectId: 'project-1', revision: 'revision-1' }),
      prepareProposal: () => preparedResult(),
      observation: observation as never,
      onObservationCompleted,
    });

    await expect(invoke(methods, 'media_describe', { assetId: 'asset-1' })).resolves.toMatchObject({
      assetId: 'asset-1',
      transcriptAvailable: true,
    });
    await expect(
      invoke(methods, 'media_observe', {
        assetId: 'asset-1',
        range: { startUs: 100, endUs: 300 },
        mode: 'focus',
        maxFrames: 2,
        maxMetadataBytes: 1024,
      }),
    ).resolves.toMatchObject({ observationId: 'observation-1', manifestId: 'manifest-1' });
    await expect(
      invoke(methods, 'media_frames', { observationId: 'observation-1', cursor: 0, pageSize: 1 }),
    ).resolves.toMatchObject({ observationId: 'observation-1', nextCursor: 1 });
    await expect(
      invoke(methods, 'media_transcript', {
        assetId: 'asset-1',
        range: { startUs: 100, endUs: 300 },
        cursor: 0,
        pageSize: 1,
      }),
    ).resolves.toMatchObject({
      transcriptId: 'transcript-1',
      wordCount: 1,
      contentAvailable: false,
    });
    await expect(
      invoke(methods, 'evidence_read', { manifestId: 'manifest-1', pageIndex: 0 }),
    ).resolves.toMatchObject({ manifestId: 'manifest-1', pageCount: 1 });
    await expect(
      invoke(methods, 'evidence_coverage', { manifestId: 'manifest-1' }),
    ).resolves.toMatchObject({
      manifestId: 'manifest-1',
      modelComprehensionGuaranteed: false,
    });

    expect(calls).toHaveLength(6);
    expect(onObservationCompleted).toHaveBeenCalledTimes(1);
    expect(onObservationCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ observationId: 'observation-1', manifestId: 'manifest-1' }),
      expect.objectContaining({
        projectId: 'project-1',
        revision: 'revision-1',
        run: { runId: 'run-1', epoch: 1 },
      }),
    );
    expect(calls.map((call) => call.authority)).toEqual(
      Array.from({ length: 6 }, () =>
        expect.objectContaining({
          projectId: 'project-1',
          revision: 'revision-1',
          run: { runId: 'run-1', epoch: 1 },
        }),
      ),
    );
    expect(
      JSON.stringify(
        await invoke(methods, 'media_frames', {
          observationId: 'observation-1',
          cursor: 0,
          pageSize: 1,
        }),
      ),
    ).not.toMatch(/blob:|https?:|file:|data:|\\\\/i);
    expect(methods).not.toHaveProperty('evidence_clear');
  });

  it('fails observation schemas and stale authority closed without forwarding client run scope or unsafe metadata', async () => {
    const methods = createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext({ projectId: 'project-1', revision: 'revision-1' }),
      prepareProposal: () => preparedResult(),
      observation: {
        isAuthorityCurrent: () => false,
        describe: async () => ({
          assetId: 'asset-1',
          assetDigest: 'c'.repeat(64),
          kind: 'video',
          durationUs: 1,
          streamCount: 1,
          transcriptAvailable: false,
        }),
        observe: async () => {
          throw new Error('not reached');
        },
        frames: async () => {
          throw new Error('not reached');
        },
        transcript: async () => {
          throw new Error('not reached');
        },
        readEvidence: async () => {
          throw new Error('not reached');
        },
        coverage: async () => {
          throw new Error('not reached');
        },
      } as never,
    });

    expect(() =>
      method(methods, 'media_describe').parseArgs({ assetId: 'asset-1', runId: 'forged' }),
    ).toThrow('JOY_AGENT_RPC_INVALID_REQUEST');
    await expect(invoke(methods, 'media_describe', { assetId: 'asset-1' })).rejects.toMatchObject({
      diagnostic: {
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        operation: 'media_describe',
        field: 'scope',
        retryable: false,
      },
    });
  });

  it('accepts a bounded source range independently of the opaque pagination cursor cap', () => {
    const methods = createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext({ projectId: 'project-1', revision: 'revision-1' }),
      prepareProposal: () => preparedResult(),
      observation: {} as never,
    });

    expect(
      method(methods, 'media_observe').parseArgs({
        assetId: 'asset-1',
        range: { startUs: 0, endUs: 3_000_000 },
        mode: 'overview',
        maxFrames: 1,
        maxMetadataBytes: 1,
      }),
    ).toMatchObject({ range: { startUs: 0, endUs: 3_000_000 } });
  });

  it('fails closed when a trusted adapter tries to exceed the model-requested observation budget', async () => {
    const methods = createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext({ projectId: 'project-1', revision: 'revision-1' }),
      prepareProposal: () => preparedResult(),
      observation: {
        isAuthorityCurrent: () => true,
        observe: async () => ({
          observationId: 'observation-1',
          manifestId: 'manifest-1',
          mode: 'focus',
          range: { startUs: 0, endUs: 100 },
          status: 'complete',
          intendedFrameCount: 3,
          decodedFrameCount: 3,
          omittedFrameCount: 0,
        }),
      } as never,
    });

    await expect(
      invoke(methods, 'media_observe', {
        assetId: 'asset-1',
        range: { startUs: 0, endUs: 100 },
        mode: 'focus',
        maxFrames: 2,
        maxMetadataBytes: 1024,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        operation: 'media_observe',
        field: 'budget',
        retryable: false,
      },
    });
  });

  it('does not let a trusted adapter overfill a requested frame or transcript metadata page', async () => {
    const frame = {
      id: 'source-frame:v1:asset-1:video-0:0',
      actualTimeUs: 0,
      durationUs: 1,
      presentationIndex: 0,
      width: 1,
      height: 1,
      cacheHit: false,
    };
    const word = { id: 'word-1', startUs: 0, endUs: 1 };
    const methods = createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext({ projectId: 'project-1', revision: 'revision-1' }),
      prepareProposal: () => preparedResult(),
      observation: {
        isAuthorityCurrent: () => true,
        frames: async () => ({
          observationId: 'observation-1',
          items: [frame, { ...frame, id: 'source-frame:v1:asset-1:video-0:1' }],
        }),
        transcript: async () => ({
          transcriptId: 'transcript-1',
          assetId: 'asset-1',
          language: 'en',
          range: { startUs: 0, endUs: 10 },
          wordCount: 2,
          contentAvailable: false,
          items: [word, { ...word, id: 'word-2', startUs: 2, endUs: 3 }],
        }),
      } as never,
    });

    await expect(
      invoke(methods, 'media_frames', { observationId: 'observation-1', cursor: 0, pageSize: 1 }),
    ).rejects.toMatchObject({ diagnostic: { field: 'budget', operation: 'media_frames' } });
    await expect(
      invoke(methods, 'media_transcript', {
        assetId: 'asset-1',
        range: { startUs: 0, endUs: 10 },
        cursor: 0,
        pageSize: 1,
      }),
    ).rejects.toMatchObject({ diagnostic: { field: 'budget', operation: 'media_transcript' } });
  });
});
