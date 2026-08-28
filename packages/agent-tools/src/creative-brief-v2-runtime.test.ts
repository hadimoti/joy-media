import { describe, expect, it, vi } from 'vitest';
import {
  createSemanticIntelligenceV1,
  createSemanticSnapshotV1,
  type IntelligenceFindingV1,
  type SemanticSnapshotV1,
} from '@joy-media/project-schema';
import {
  executeCreativeBriefV2,
  type CreativeBriefV2AdapterContext,
  type CreativeBriefV2AsyncAdapter,
  type CreativeBriefV2AuditEvent,
  type CreativeBriefV2Request,
  type CreativeBriefV2Result,
} from './index.js';

const PROJECT_ID = 'project-runtime-v2';
const PROJECT_REVISION = 'local-revision:v1:project-runtime-v2:timeline=3:document=5';

describe('Creative Brief v2 async runtime boundary', () => {
  it('returns a validated ready result and forwards only runtime metadata', async () => {
    const request = requestFixture();
    const result = resultFixture(request);
    let receivedContext: CreativeBriefV2AdapterContext | undefined;
    const createBrief = vi.fn(
      async (_request: CreativeBriefV2Request, context: CreativeBriefV2AdapterContext) => {
        receivedContext = context;
        return { category: 'ready' as const, result };
      },
    );

    const outcome = await executeCreativeBriefV2(request, adapter(createBrief), {
      correlationId: 'correlation-ready',
    });

    expect(outcome).toMatchObject({ category: 'ready', retryable: false, result });
    expect(createBrief).toHaveBeenCalledOnce();
    expect(receivedContext).toMatchObject({ correlationId: 'correlation-ready' });
    expect(receivedContext?.signal).toBeInstanceOf(AbortSignal);
  });

  it('short-circuits invalid requests before invoking the adapter', async () => {
    const createBrief = vi.fn();
    const outcome = await executeCreativeBriefV2(
      { ...requestFixture(), projectId: 'wrong-project' },
      adapter(createBrief),
      { correlationId: 'correlation-invalid-request' },
    );

    expect(outcome).toMatchObject({ category: 'invalid-request', retryable: false });
    expect(createBrief).not.toHaveBeenCalled();
  });

  it('rejects provider output that does not satisfy the v2 contract', async () => {
    const request = requestFixture();
    const outcome = await executeCreativeBriefV2(
      request,
      adapter(async () => ({
        category: 'ready',
        result: { ...resultFixture(request), requestId: 'stale-request' },
      })),
      { correlationId: 'correlation-invalid-output' },
    );

    expect(outcome).toMatchObject({ category: 'invalid-output', retryable: false });
    expect(outcome).not.toHaveProperty('result');
  });

  it('cancels an in-flight adapter through the composed signal', async () => {
    const controller = new AbortController();
    const observedSignals: AbortSignal[] = [];
    const pendingAdapter = adapter((_request, context) => {
      observedSignals.push(context.signal);
      return new Promise(() => undefined);
    });
    const execution = executeCreativeBriefV2(requestFixture(), pendingAdapter, {
      correlationId: 'correlation-cancelled',
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();

    await expect(execution).resolves.toMatchObject({ category: 'cancelled', retryable: false });
    expect(observedSignals[0]?.aborted).toBe(true);
  });

  it('times out and aborts an adapter that does not settle', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const execution = executeCreativeBriefV2(
        requestFixture(),
        adapter((_request, context) => {
          signal = context.signal;
          return new Promise(() => undefined);
        }),
        { correlationId: 'correlation-timeout', timeoutMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(25);

      await expect(execution).resolves.toMatchObject({ category: 'timeout', retryable: true });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes thrown provider errors', async () => {
    const outcome = await executeCreativeBriefV2(
      requestFixture(),
      adapter(async () => {
        throw new Error('api_key=sk-private and https://private.example');
      }),
      { correlationId: 'correlation-provider-error' },
    );

    expect(outcome).toEqual({
      category: 'provider-failed',
      retryable: true,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(outcome)).not.toMatch(/api_key|private\.example|sk-private/);
  });

  it('fails closed when an adapter violates the outcome protocol', async () => {
    const outcome = await executeCreativeBriefV2(
      requestFixture(),
      adapter(
        async () =>
          ({
            category: 'internal-secret-state',
            retryable: 'yes',
          }) as never,
      ),
      { correlationId: 'correlation-invalid-adapter-outcome' },
    );

    expect(outcome).toMatchObject({ category: 'provider-failed', retryable: true });
    expect(JSON.stringify(outcome)).not.toContain('internal-secret-state');
  });

  it('emits only redacted start/end audit metadata and constrains provider error codes', async () => {
    const request = requestFixture();
    const events: CreativeBriefV2AuditEvent[] = [];
    const outcome = await executeCreativeBriefV2(
      request,
      adapter(async () => ({
        category: 'unavailable',
        retryable: true,
        errorCode: 'unsafe code: api_key=secret',
      })),
      {
        correlationId: 'correlation-audit',
        auditSink: { emit: (event) => events.push(event) },
      },
    );

    expect(outcome).toMatchObject({ category: 'unavailable', retryable: true });
    expect(outcome).not.toHaveProperty('errorCode');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual(['start', 'end']);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(request.goal);
    expect(serialized).not.toMatch(/snapshot|intelligence|recommendations|secret/);
  });

  it.each([0, -1, 120_001, 1.5])(
    'rejects an unsafe timeout before adapter execution: %s',
    async (timeoutMs) => {
      const createBrief = vi.fn();
      await expect(
        executeCreativeBriefV2(requestFixture(), adapter(createBrief), {
          correlationId: 'correlation-invalid-timeout',
          timeoutMs,
        }),
      ).rejects.toThrow(/timeoutMs/);
      expect(createBrief).not.toHaveBeenCalled();
    },
  );
});

function adapter(
  createBrief: CreativeBriefV2AsyncAdapter['createBrief'],
): CreativeBriefV2AsyncAdapter {
  return { adapterName: 'test-creative-brief-v2', createBrief };
}

function requestFixture(): CreativeBriefV2Request {
  const snapshot = snapshotFixture();
  const finding: IntelligenceFindingV1 = {
    id: 'finding-opening-duration',
    category: 'timing',
    severity: 'notice',
    title: 'Opening duration',
    description: 'The opening clip lasts eight seconds.',
    evidenceIds: ['clip-opening'],
    evidenceKind: 'clip',
  };
  return {
    schemaVersion: 2,
    requestId: 'request-runtime-v2',
    projectId: PROJECT_ID,
    projectRevisionId: PROJECT_REVISION,
    goal: 'Review the opening pace without applying edits.',
    evidenceIds: ['clip-opening'],
    snapshot,
    intelligence: createSemanticIntelligenceV1([finding], [], {
      projectId: PROJECT_ID,
      snapshotRevision: snapshot.metadata.revision,
      createdBy: 'test',
      contentHash: 'intelligence-hash',
    }),
  };
}

function resultFixture(request: CreativeBriefV2Request): CreativeBriefV2Result {
  return {
    schemaVersion: 2,
    requestId: request.requestId,
    projectId: request.projectId,
    projectRevisionId: request.projectRevisionId,
    summary: 'The opening duration is measurable.',
    rationale: 'The cited clip provides bounded timing evidence.',
    evidenceIds: ['clip-opening'],
    recommendations: [
      {
        id: 'recommendation-opening-pacing',
        summary: 'Consider a shorter opening pause.',
        rationale: 'The opening clip is eight seconds long.',
        confidence: 'medium',
        evidenceIds: ['clip-opening'],
      },
    ],
    warnings: [],
  };
}

function snapshotFixture(): SemanticSnapshotV1 {
  return createSemanticSnapshotV1(
    [
      {
        id: 'timeline',
        label: 'Timeline',
        domain: 'timeline',
        evidence: [
          {
            id: 'clip-opening',
            kind: 'clip',
            label: 'Opening clip',
            summary: 'Opening clip lasts eight seconds.',
            sourceEntityId: 'clip-1',
            sourceEntityRevision: 1,
            startUs: 0,
            durationUs: 8_000_000,
          },
        ],
      },
    ],
    {
      projectId: PROJECT_ID,
      revision: 7,
      schemaVersion: 2,
      contentHash: 'snapshot-hash',
      createdBy: 'test',
    },
  );
}
