import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import {
  ApprovalEngine,
  buildEditorContext,
  createIdempotencyStore,
  createPreviewAndApprovePolicy,
  createToolRegistry,
  runPlanAtomically,
} from '@joy-media/agent-tools';
import {
  routeJoyCodePrompt,
  JoyCodeReasoningDetails,
  buildJoyCodeReasoningRequest,
  buildPendingPlanFromJoyCodeProposal,
  type JoyCodeReasoningResponse,
} from './AgentPanel.js';
import {
  BrowserControlPlaneClient,
  BrowserControlPlaneError,
  type BrowserProviderApprovalGrant,
} from './control-plane-client.js';

describe('Joy Code critique helpers', () => {
  it('keeps read-only critique responses bounded to evidence and leaves the revision unchanged', () => {
    const project = buildReferenceSpikeProject();
    const revision = 'local-revision:v1:project:timeline=1:document=1:graph=0:artifacts=0';
    const request = buildJoyCodeReasoningRequest({
      project,
      selectedClipIds: ['intro'],
      playheadUs: 5_000_000,
      attachedAssets: [],
      settings: {
        reasoningModel: 'mistral-small-latest',
        privacyMode: 'ask-before-remote',
      },
      projectRevision: revision,
      goal: 'Critique the opening pacing only.',
    });

    expect(request.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: 'clip:intro',
          kind: 'selected-clip',
        }),
        expect.objectContaining({
          evidenceId: 'playhead:5000000',
          kind: 'timeline-range',
        }),
      ]),
    );
    expect(request.snapshotDigest).toMatch(/^fnv1a-[a-f0-9]+$/);

    const response: JoyCodeReasoningResponse = {
      responseVersion: 1,
      requestId: 'joy-code-critique-1',
      brief: {
        summary: 'The opening repeats setup beats before the product arrives.',
        rationale: 'The cited intro evidence supports a read-only pacing critique.',
        evidenceReferences: ['clip:intro'],
      },
      provider: {
        providerId: 'mistral',
        modelId: 'mistral-small-latest',
        decisionRef: 'provider-decision-joy-code-critique-1',
        briefRef: 'reasoning-brief-joy-code-critique-1',
        requestDigest: 'sha256:critique',
        dataLeavesDevice: true,
        retentionDisclosure: 'Prompt text is sent to Mistral for remote processing.',
        usage: { inputTokens: 9, outputTokens: 7 },
      },
    };

    const html = renderToStaticMarkup(<JoyCodeReasoningDetails reasoning={response} />);
    expect(html).toContain('mistral-small-latest');
    expect(html).toContain('provider-decision-joy-code-critique-1');
    expect(html).toContain('reasoning-brief-joy-code-critique-1');
    expect(html).toContain('9 in / 7 out');

    expect(
      buildPendingPlanFromJoyCodeProposal({
        response,
        project,
        selectedClipIds: ['intro'],
        playheadUs: 5_000_000,
        baseRevision: revision,
        registry: createToolRegistry(),
        approvalEngine: new ApprovalEngine(createPreviewAndApprovePolicy()),
        agentContext: buildEditorContext(project),
      }),
    ).toBeUndefined();
    expect(revision).toBe(request.projectRevision);
  });

  it('keeps proposed edits as a dry-run plan until approval, then commits them as one transaction', () => {
    const project = buildReferenceSpikeProject();
    const registry = createToolRegistry();
    const approvalEngine = new ApprovalEngine(createPreviewAndApprovePolicy());
    const response: JoyCodeReasoningResponse = {
      responseVersion: 1,
      requestId: 'joy-code-proposal-1',
      brief: {
        summary: 'The intro can be shortened while keeping the narrative intact.',
        rationale: 'The bounded intro evidence supports a small pacing trim.',
        evidenceReferences: ['clip:intro'],
      },
      proposal: {
        intentId: 'shorten-intro',
        summary: 'Shorten the intro by 2 seconds.',
        rationale: 'Trim only the intro section cited in evidence.',
        evidenceReferences: ['clip:intro'],
      },
      provider: {
        providerId: 'mistral',
        modelId: 'mistral-small-latest',
        decisionRef: 'provider-decision-joy-code-proposal-1',
        briefRef: 'reasoning-brief-joy-code-proposal-1',
        requestDigest: 'sha256:proposal',
        dataLeavesDevice: true,
        usage: { inputTokens: 12, outputTokens: 10 },
      },
    };

    const pending = buildPendingPlanFromJoyCodeProposal({
      response,
      project,
      selectedClipIds: ['intro'],
      playheadUs: 5_000_000,
      baseRevision: 'rev-joy-code-1',
      registry,
      approvalEngine,
      agentContext: buildEditorContext(project),
    });

    expect(pending).toBeDefined();
    expect(pending?.intent.id).toBe('shorten-intro');
    expect(pending?.dryRun.aggregateDiff.summary).toContain('clip(s) modified');
    expect(pending?.approval.decision).toBe('requires-manual');
    expect(pending?.reasoning?.proposal?.intentId).toBe('shorten-intro');

    const commits: { label: string; commands: readonly unknown[] }[] = [];
    const atomic = runPlanAtomically(pending!.plan, {
      registry,
      approvalEngine,
      actor: { type: 'agent', id: 'kilocode' },
      projectId: project.id,
      baseRevision: pending!.baseRevision,
      baseProject: project,
      contextFor: (staged) => buildEditorContext(staged),
      currentRevision: () => pending!.baseRevision,
      idempotency: createIdempotencyStore(),
      manualApproval: {
        planId: pending!.plan.planId,
        approvedAt: '2026-08-22T00:00:00.000Z',
      },
      commit: (transaction) => {
        commits.push(transaction);
        return { success: true };
      },
    });

    expect(atomic.committed).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.commands.length).toBeGreaterThan(1);
  });

  it('routes unmatched Joy Code prompts to bounded reasoning instead of rejecting them', () => {
    expect(routeJoyCodePrompt('shorten the intro')).toMatchObject({ kind: 'intent' });
    expect(routeJoyCodePrompt('make the opening feel more cinematic')).toEqual({
      kind: 'reasoning',
    });
  });

  it('preserves provider approval preflight in the client and resubmits reasoning with the signed grant', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ readonly url: string; readonly body?: string }> = [];
    const signedGrant: BrowserProviderApprovalGrant = {
      grantVersion: 1,
      grantId: 'grant-joy-code-browser-1',
      grantSignature: 'signed-grant',
      actorId: 'owner',
      providerId: 'mistral',
      capability: 'llm.complete',
      requestDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      expiresAt: '2026-08-22T00:05:00.000Z',
      status: 'approved',
      costCap: { amount: '0.00', currency: 'USD' },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ url, ...(body === undefined ? {} : { body }) });
      if (url.endsWith('/v1/providers/reasoning/joy-code') && requests.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'PROVIDER_APPROVAL_REQUIRED',
              message: 'Provider processing requires an approval grant bound to this request.',
              preflight: {
                providerId: 'mistral',
                capability: 'llm.complete',
                requestDigest: signedGrant.requestDigest,
                dataLeavesDevice: true,
                dataBeingSent: ['text prompt'],
                purpose: 'Complete text generation',
                estimatedSizeBytes: 5000,
                transformations: ['remote API call'],
                requiresUserApproval: true,
                estimatedCost: { amount: '0.00', currency: 'USD' },
              },
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/v1/providers/approvals/grants')) {
        return new Response(JSON.stringify({ data: signedGrant }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          data: {
            responseVersion: 1,
            requestId: 'joy-code-approved-1',
            brief: {
              summary: 'Approved bounded critique.',
              rationale: 'Approved for remote reasoning.',
              evidenceReferences: ['clip:intro'],
            },
            provider: {
              providerId: 'mistral',
              modelId: 'mistral-small-latest',
              decisionRef: 'provider-decision-approved-1',
              briefRef: 'reasoning-brief-approved-1',
              requestDigest: signedGrant.requestDigest,
              dataLeavesDevice: true,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      const client = new BrowserControlPlaneClient('https://media.joyteam.ir/api', () => 'session');
      const request = {
        model: 'mistral-small-latest',
        goal: 'Critique the opening pacing only.',
        snapshotDigest: 'fnv1a-abc123',
        projectRevision: 'rev-1',
        idempotencyKey: 'joy-code-browser-1',
        privacyMode: 'ask-before-remote' as const,
        evidence: [
          {
            evidenceId: 'clip:intro',
            kind: 'selected-clip' as const,
            label: 'Intro',
            detail: '0s to 10s',
          },
        ],
        allowedIntentIds: ['shorten-intro'],
      };

      const error = await client.joyCodeReasoning(request).catch((reason) => reason);
      expect(error).toBeInstanceOf(BrowserControlPlaneError);
      expect(error).toMatchObject({
        code: 'PROVIDER_APPROVAL_REQUIRED',
        preflight: {
          providerId: 'mistral',
          capability: 'llm.complete',
          requestDigest: signedGrant.requestDigest,
        },
      });

      const grant = await client.issueProviderApprovalGrant({
        providerId: error.preflight.providerId,
        capability: error.preflight.capability,
        requestDigest: error.preflight.requestDigest,
        costCap: error.preflight.estimatedCost,
      });
      const approved = await client.joyCodeReasoning({ ...request, providerApprovalGrant: grant });

      expect(approved.brief.summary).toBe('Approved bounded critique.');
      expect(requests.map((entry) => entry.url)).toEqual([
        'https://media.joyteam.ir/api/v1/providers/reasoning/joy-code',
        'https://media.joyteam.ir/api/v1/providers/approvals/grants',
        'https://media.joyteam.ir/api/v1/providers/reasoning/joy-code',
      ]);
      expect(requests[1]?.body).toContain(`"requestDigest":"${signedGrant.requestDigest}"`);
      expect(requests[2]?.body).toContain('"providerApprovalGrant"');
      expect(requests[2]?.body).toContain('"grantSignature":"signed-grant"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
