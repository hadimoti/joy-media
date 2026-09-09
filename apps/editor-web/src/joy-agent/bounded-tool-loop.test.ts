import { describe, expect, it, vi } from 'vitest';
import * as agentTools from '@joy-media/agent-tools';
import {
  BROWSER_AGENT_TOOLS,
  JOY_AGENT_HOST_TOOL_NAMES,
  createBrowserAgentToolCatalog,
  createBrowserAgentTools,
  runBoundedToolExchange,
  validateBrowserProposal,
  type BrowserAgentHostCall,
  type JoyAgentHostToolName,
} from './bounded-tool-loop.js';
import { listModelVisibleJoyEditorOperations } from './editor-operation-registry.js';
import { HostRpcError, type HostRpcJson } from './host-rpc.js';

const proposal = {
  summary: 'Move the selected clip',
  operations: [
    {
      id: 'move',
      kind: 'timeline.moveClip',
      compositionId: 'composition',
      clipId: 'clip',
      sourceTrackId: 'track',
      targetTrackId: 'track',
      newStartUs: 500,
      dependsOn: [],
    },
  ],
};

const frozenPage = {
  projectId: 'project',
  revision: 'revision',
  selectedClipIds: ['clip'],
  trackIds: ['track'],
} as const satisfies HostRpcJson;

const opaquePrepared = {
  summary: proposal.summary,
  baseRevision: 'revision',
  changeSetId: 'change-set-1',
  operationDigest: 'a'.repeat(64),
  bindingDigest: 'b'.repeat(64),
  operationCount: 1,
} as const satisfies HostRpcJson;

const response = (message: unknown): string => JSON.stringify({ choices: [{ message }] });

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const lastToolResult = (messages: readonly unknown[]): unknown => {
  const message = [...messages]
    .reverse()
    .find(
      (item): item is { readonly role: string; readonly content: string } =>
        item !== null &&
        typeof item === 'object' &&
        (item as { readonly role?: unknown }).role === 'tool' &&
        typeof (item as { readonly content?: unknown }).content === 'string',
    );
  if (message === undefined) throw new Error('Expected a tool result');
  return JSON.parse(message.content);
};

const hostError = (retryable = true): HostRpcError =>
  new HostRpcError({
    code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
    retryable,
    operation: 'timeline.moveClip',
    field: 'clipId',
    facts: { knownClip: false },
  });

describe('mounted Worker bounded semantic tool exchange', () => {
  it('publishes only the known host-tool names and builds an explicit strict observation catalog', () => {
    expect(JOY_AGENT_HOST_TOOL_NAMES).toEqual([
      'read_project_context',
      'validate_proposal',
      'media_describe',
      'media_observe',
      'media_frames',
      'media_transcript',
      'evidence_read',
      'evidence_coverage',
      'look_apply',
      'look_update',
      'look_reset_overrides',
      'look_detach',
    ]);

    const allowedToolNames = [
      'read_project_context',
      'media_describe',
      'media_observe',
      'media_frames',
      'media_transcript',
      'evidence_read',
      'evidence_coverage',
    ] as const satisfies readonly JoyAgentHostToolName[];
    const catalog = createBrowserAgentToolCatalog(
      agentTools.createModelVisibleJoyCodeProposalParameters(),
      allowedToolNames,
    );

    expect(catalog.allowedToolNames).toEqual(allowedToolNames);
    expect(catalog.tools.map((tool) => tool.function.name)).toEqual(allowedToolNames);
    expect(catalog.tools.map((tool) => tool.function.name)).not.toContain('evidence_clear');
    expect(
      catalog.tools
        .filter((tool) => tool.function.name !== 'read_project_context')
        .every((tool) => tool.function.strict === true),
    ).toBe(true);
    expect(catalog.tools.find((tool) => tool.function.name === 'media_observe')).toMatchObject({
      type: 'function',
      function: {
        name: 'media_observe',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['assetId', 'range', 'mode', 'maxFrames', 'maxMetadataBytes'],
          properties: {
            assetId: { type: 'string', minLength: 1, maxLength: 128 },
            range: {
              type: 'object',
              additionalProperties: false,
              required: ['startUs', 'endUs'],
            },
            mode: { enum: ['overview', 'focus', 'exhaustive'] },
            maxFrames: { type: 'integer', minimum: 1, maximum: 512 },
            maxMetadataBytes: { type: 'integer', minimum: 1, maximum: 32_768 },
          },
        },
      },
    });
    expect(catalog.tools.find((tool) => tool.function.name === 'media_frames')).toMatchObject({
      function: {
        strict: true,
        parameters: {
          additionalProperties: false,
          required: ['observationId', 'cursor', 'pageSize'],
          properties: {
            cursor: { type: 'integer', minimum: 0, maximum: 2_097_152 },
            pageSize: { type: 'integer', minimum: 1, maximum: 128 },
          },
        },
      },
    });
  });

  it('fails closed for malformed or contextless host-approved tool catalogs', () => {
    const proposalParameters = agentTools.createModelVisibleJoyCodeProposalParameters();
    expect(() => createBrowserAgentToolCatalog(proposalParameters, ['media_describe'])).toThrow(
      'READ_PROJECT_CONTEXT',
    );
    expect(() =>
      createBrowserAgentToolCatalog(undefined, ['read_project_context', 'validate_proposal']),
    ).toThrow('VALIDATE_PROPOSAL');
    expect(() =>
      createBrowserAgentToolCatalog(proposalParameters, [
        'read_project_context',
        'media_describe',
        'media_describe',
      ]),
    ).toThrow('INVALID');
    expect(() =>
      createBrowserAgentToolCatalog(proposalParameters, [
        'read_project_context',
        'evidence_clear' as unknown as JoyAgentHostToolName,
      ]),
    ).toThrow('INVALID');
  });

  it('advertises exactly the package-generated operation schema', () => {
    expect(BROWSER_AGENT_TOOLS.map((tool) => tool.function.name)).toEqual([
      'read_project_context',
      'validate_proposal',
    ]);
    const proposalTool = BROWSER_AGENT_TOOLS.find(
      (tool) => tool.function.name === 'validate_proposal',
    );

    expect(proposalTool?.function.parameters).toEqual(
      agentTools.createModelVisibleJoyCodeProposalParameters(),
    );
    expect(proposalTool?.function.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        operations: {
          type: 'array',
          items: {
            oneOf: listModelVisibleJoyEditorOperations().map(({ kind }) =>
              expect.objectContaining({
                properties: expect.objectContaining({ kind: { const: kind } }),
              }),
            ),
          },
        },
      },
    });
    expect(createBrowserAgentTools(undefined).map((tool) => tool.function.name)).toEqual([
      'read_project_context',
    ]);
  });

  it('keeps local schema validation narrow and rejects invalid operation input', () => {
    expect(validateBrowserProposal(proposal)).toEqual(proposal);
    const visibleKinds = vi
      .spyOn(agentTools, 'listModelVisibleJoyCodeOperationKinds')
      .mockReturnValue(['timeline.trimClip']);
    try {
      expect(() => validateBrowserProposal(proposal)).toThrow('invalid proposal operations');
    } finally {
      visibleKinds.mockRestore();
    }
    expect(() => validateBrowserProposal({ summary: 'Bad', operations: [null] })).toThrow(
      'invalid',
    );
  });

  it('reads only through the host and returns an opaque canonical prepared reference', async () => {
    const host = vi.fn<BrowserAgentHostCall>(async (method, args) => {
      if (method === 'read_project_context') {
        expect(args).toEqual({ domain: 'overview', pageSize: 1 });
        return frozenPage;
      }
      expect(args).toEqual(proposal);
      return opaquePrepared;
    });
    let step = 0;

    const outcome = await runBoundedToolExchange(
      [],
      async (messages) => {
        if (step++ === 0)
          return response({
            tool_calls: [
              call('read-overview', 'read_project_context', { domain: 'overview', pageSize: 1 }),
            ],
          });
        expect(lastToolResult(messages)).toEqual({ ok: true, context: frozenPage, applied: false });
        return response({ tool_calls: [call('prepare', 'validate_proposal', proposal)] });
      },
      host,
    );

    expect(host.mock.calls.map(([method]) => method)).toEqual([
      'read_project_context',
      'validate_proposal',
    ]);
    expect(outcome).toEqual({ kind: 'prepared', proposal: opaquePrepared });
    if (outcome.kind !== 'prepared') throw new Error('Expected canonical preparation');
    expect(outcome.proposal).not.toHaveProperty('operations');
    expect(JSON.stringify(outcome)).not.toContain('"operations"');
  });

  it('returns structured host diagnostics for repair, charges the hooks, and retries once', async () => {
    let validates = 0;
    const toolCalls: string[] = [];
    const repairAttempts: number[] = [];
    const host = vi.fn<BrowserAgentHostCall>(async (method) => {
      if (method === 'read_project_context') return frozenPage;
      validates += 1;
      if (validates === 1) throw hostError();
      return opaquePrepared;
    });
    let step = 0;

    const outcome = await runBoundedToolExchange(
      [],
      async (messages) => {
        if (step++ === 0)
          return response({
            tool_calls: [call('read', 'read_project_context', { domain: 'overview' })],
          });
        if (step === 2)
          return response({ tool_calls: [call('invalid', 'validate_proposal', proposal)] });
        expect(lastToolResult(messages)).toEqual({
          ok: false,
          code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
          repairable: true,
          operation: 'timeline.moveClip',
          field: 'clipId',
          facts: { knownClip: false },
          applied: false,
        });
        return response({ tool_calls: [call('repair', 'validate_proposal', proposal)] });
      },
      host,
      {
        onToolCall: (name) => toolCalls.push(name),
        onRepairAttempt: () => repairAttempts.push(1),
      },
    );

    expect(outcome).toEqual({ kind: 'prepared', proposal: opaquePrepared });
    expect(toolCalls).toEqual(['read_project_context', 'validate_proposal', 'validate_proposal']);
    expect(repairAttempts).toEqual([1]);
    expect(validates).toBe(2);
  });

  it('requires a read in an earlier model turn before it may prepare', async () => {
    const host = vi.fn<BrowserAgentHostCall>(async (method) =>
      method === 'read_project_context' ? frozenPage : opaquePrepared,
    );
    let step = 0;

    const outcome = await runBoundedToolExchange(
      [],
      async (messages) => {
        if (step++ === 0)
          return response({
            tool_calls: [
              call('read', 'read_project_context', { domain: 'overview' }),
              call('too-early', 'validate_proposal', proposal),
            ],
          });
        expect(lastToolResult(messages)).toEqual({
          ok: false,
          code: 'JOY_AGENT_CONTEXT_REQUIRED',
          repairable: true,
          applied: false,
        });
        return response({ tool_calls: [call('prepare', 'validate_proposal', proposal)] });
      },
      host,
    );

    expect(outcome).toEqual({ kind: 'prepared', proposal: opaquePrepared });
    expect(host.mock.calls.map(([method]) => method)).toEqual([
      'read_project_context',
      'validate_proposal',
    ]);
  });

  it('rejects recognized tools that the host did not approve for this run', async () => {
    const host = vi.fn<BrowserAgentHostCall>(async () => frozenPage);

    await expect(
      runBoundedToolExchange(
        [],
        async () =>
          response({
            tool_calls: [call('unapproved-media', 'media_describe', { assetId: 'asset-1' })],
          }),
        host,
        { allowedToolNames: ['read_project_context'] },
      ),
    ).rejects.toThrow('invalid proposal tool');
    expect(host).not.toHaveBeenCalled();

    await expect(
      runBoundedToolExchange(
        [],
        async () =>
          response({
            tool_calls: [call('forbidden-clear', 'evidence_clear', { manifestId: 'manifest-1' })],
          }),
        host,
      ),
    ).rejects.toThrow('invalid proposal tool');
    expect(host).not.toHaveBeenCalled();
  });

  it('requires a successful context read in an earlier model turn before an approved observation', async () => {
    const toolCalls: JoyAgentHostToolName[] = [];
    const host = vi.fn<BrowserAgentHostCall>(async (method) => {
      if (method === 'read_project_context') return frozenPage;
      if (method === 'media_describe') {
        return {
          assetId: 'asset-1',
          assetDigest: 'a'.repeat(64),
          kind: 'video',
          durationUs: 1_000_000,
          streamCount: 2,
          transcriptAvailable: false,
        } as const satisfies HostRpcJson;
      }
      throw new Error(`Unexpected tool: ${method}`);
    });
    let step = 0;

    const outcome = await runBoundedToolExchange(
      [],
      async () => {
        if (step++ === 0)
          return response({
            tool_calls: [call('read', 'read_project_context', { domain: 'overview' })],
          });
        if (step === 2)
          return response({
            tool_calls: [call('describe', 'media_describe', { assetId: 'asset-1' })],
          });
        return response({ content: 'The selected asset is a video.' });
      },
      host,
      {
        allowedToolNames: ['read_project_context', 'media_describe'],
        onToolCall: (name) => toolCalls.push(name),
      },
    );

    expect(outcome).toEqual({ kind: 'answer', text: 'The selected asset is a video.' });
    expect(host.mock.calls.map(([method]) => method)).toEqual([
      'read_project_context',
      'media_describe',
    ]);
    expect(toolCalls).toEqual(['read_project_context', 'media_describe']);
  });

  it('does not allow a context read and observation in the same model turn', async () => {
    const host = vi.fn<BrowserAgentHostCall>(async (method) => {
      if (method === 'read_project_context') return frozenPage;
      throw new Error(`Observation must not reach host: ${method}`);
    });
    let step = 0;

    const outcome = await runBoundedToolExchange(
      [],
      async (messages) => {
        if (step++ === 0)
          return response({
            tool_calls: [
              call('read', 'read_project_context', { domain: 'overview' }),
              call('describe', 'media_describe', { assetId: 'asset-1' }),
            ],
          });
        expect(lastToolResult(messages)).toEqual({
          ok: false,
          code: 'JOY_AGENT_CONTEXT_REQUIRED',
          repairable: true,
          applied: false,
        });
        return response({ content: 'I need the project context before observing media.' });
      },
      host,
      { allowedToolNames: ['read_project_context', 'media_describe'] },
    );

    expect(outcome).toEqual({
      kind: 'answer',
      text: 'I need the project context before observing media.',
    });
    expect(host.mock.calls.map(([method]) => method)).toEqual(['read_project_context']);
  });

  it('permits valid zero-operation answers and clarifications without a host call', async () => {
    const host = vi.fn<BrowserAgentHostCall>(async () => {
      throw new Error('The host must not be called for a non-mutating answer');
    });

    await expect(
      runBoundedToolExchange(
        [],
        async () => response({ content: 'I can explain the current timeline.' }),
        host,
      ),
    ).resolves.toEqual({ kind: 'answer', text: 'I can explain the current timeline.' });
    await expect(
      runBoundedToolExchange(
        [],
        async () =>
          response({
            content: JSON.stringify({ question: 'Which clip should I adjust?', operations: [] }),
          }),
        host,
      ),
    ).resolves.toEqual({ kind: 'clarification', question: 'Which clip should I adjust?' });
    expect(host).not.toHaveBeenCalled();
  });

  it('rejects unprepared non-empty proposals and host output that tries to expose operations', async () => {
    const failHost = vi.fn<BrowserAgentHostCall>(async () => ({
      ...opaquePrepared,
      operations: [],
    }));

    await expect(
      runBoundedToolExchange(
        [],
        async () => response({ content: JSON.stringify(proposal) }),
        failHost,
      ),
    ).rejects.toThrow('canonical preparation');

    let step = 0;
    await expect(
      runBoundedToolExchange(
        [],
        async (messages) => {
          if (step++ === 0)
            return response({
              tool_calls: [call('read', 'read_project_context', { domain: 'overview' })],
            });
          if (step === 2)
            return response({ tool_calls: [call('prepare', 'validate_proposal', proposal)] });
          expect(lastToolResult(messages)).toEqual({
            ok: false,
            code: 'JOY_AGENT_INVALID_PROPOSAL',
            repairable: true,
            applied: false,
          });
          return response({ content: 'The canonical preview was not created.' });
        },
        failHost,
      ),
    ).resolves.toEqual({ kind: 'answer', text: 'The canonical preview was not created.' });
  });

  it('honors cancellation before a later validation can reach the host', async () => {
    const controller = new AbortController();
    const host = vi.fn<BrowserAgentHostCall>(async (method) => {
      if (method === 'read_project_context') {
        controller.abort();
        return frozenPage;
      }
      return opaquePrepared;
    });

    await expect(
      runBoundedToolExchange(
        [],
        async () =>
          response({ tool_calls: [call('read', 'read_project_context', { domain: 'overview' })] }),
        host,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(host.mock.calls.map(([method]) => method)).toEqual(['read_project_context']);
  });

  it('fails closed for invalid tools, duplicate IDs, and bounded model/tool counts', async () => {
    const host = vi.fn<BrowserAgentHostCall>(async () => frozenPage);

    await expect(
      runBoundedToolExchange(
        [],
        async () => response({ tool_calls: [call('shell', 'execute_shell')] }),
        host,
      ),
    ).rejects.toThrow('invalid proposal tool');
    await expect(
      runBoundedToolExchange(
        [],
        async () =>
          response({
            tool_calls: [
              call('same', 'read_project_context', { domain: 'overview' }),
              call('same', 'read_project_context', { domain: 'clips' }),
            ],
          }),
        host,
      ),
    ).rejects.toThrow('invalid proposal tool');
    await expect(
      runBoundedToolExchange(
        [],
        async () =>
          response({
            tool_calls: Array.from({ length: 9 }, (_, index) =>
              call(`read-${index}`, 'read_project_context', { domain: 'overview' }),
            ),
          }),
        host,
      ),
    ).rejects.toThrow('tool limit');

    await expect(
      runBoundedToolExchange(
        [],
        async () =>
          response({
            tool_calls: [call('budgeted-read', 'read_project_context', { domain: 'overview' })],
          }),
        host,
        { maxToolCalls: 0 },
      ),
    ).rejects.toThrow('tool limit');

    let modelSteps = 0;
    await expect(
      runBoundedToolExchange(
        [],
        async () => {
          modelSteps += 1;
          return response({
            tool_calls: [
              call(`read-step-${modelSteps}`, 'read_project_context', { domain: 'overview' }),
            ],
          });
        },
        host,
      ),
    ).rejects.toThrow('tool limit');
    expect(modelSteps).toBe(4);
  });

  it('does not retry a non-repairable canonical rejection', async () => {
    const host = vi.fn<BrowserAgentHostCall>(async (method) => {
      if (method === 'read_project_context') return frozenPage;
      throw hostError(false);
    });
    let step = 0;

    await expect(
      runBoundedToolExchange(
        [],
        async () => {
          if (step++ === 0)
            return response({
              tool_calls: [call('read', 'read_project_context', { domain: 'overview' })],
            });
          return response({ tool_calls: [call('prepare', 'validate_proposal', proposal)] });
        },
        host,
      ),
    ).rejects.toMatchObject({ diagnostic: { code: 'JOY_AGENT_RPC_CANONICAL_REJECTED' } });
    expect(step).toBe(2);
  });

  it('advertises Look intent tools only when explicitly allowed', () => {
    const proposalParameters = agentTools.createModelVisibleJoyCodeProposalParameters();
    expect(BROWSER_AGENT_TOOLS.map((tool) => tool.function.name)).not.toContain('look_apply');
    const catalog = createBrowserAgentToolCatalog(proposalParameters, [
      'read_project_context',
      'look_apply',
      'look_update',
      'look_reset_overrides',
      'look_detach',
    ]);
    expect(catalog.tools.map((tool) => tool.function.name)).toEqual([
      'read_project_context',
      'look_apply',
      'look_update',
      'look_reset_overrides',
      'look_detach',
    ]);
    const applyTool = catalog.tools.find((tool) => tool.function.name === 'look_apply');
    expect(applyTool?.function.parameters).toMatchObject({
      required: ['definitionId', 'entityBindings', 'controlValues'],
    });
  });

  it('treats a Look intent tool call as terminal, like validate_proposal', async () => {
    const lookInput = {
      definitionId: 'editorial-clean',
      entityBindings: { title: 'text-1' },
      controlValues: { emphasis: 0.6 },
    };
    const lookPrepared = {
      summary: 'Apply the "Editorial Clean" Look',
      baseRevision: 'revision',
      changeSetId: 'change-set-look-1',
      operationDigest: 'c'.repeat(64),
      bindingDigest: 'd'.repeat(64),
      operationCount: 3,
    } as const satisfies HostRpcJson;
    const host = vi.fn<BrowserAgentHostCall>(async (method, args) => {
      if (method === 'read_project_context') return frozenPage;
      expect(method).toBe('look_apply');
      expect(args).toEqual(lookInput);
      return lookPrepared;
    });
    let step = 0;
    const outcome = await runBoundedToolExchange(
      [],
      async () => {
        if (step++ === 0)
          return response({
            tool_calls: [call('read', 'read_project_context', { domain: 'overview' })],
          });
        return response({ tool_calls: [call('apply-look', 'look_apply', lookInput)] });
      },
      host,
      {
        allowedToolNames: ['read_project_context', 'look_apply', 'look_update', 'look_detach'],
      },
    );
    expect(host.mock.calls.map(([method]) => method)).toEqual([
      'read_project_context',
      'look_apply',
    ]);
    expect(outcome).toEqual({ kind: 'prepared', proposal: lookPrepared });
  });

  it('requires project context before a Look intent tool', async () => {
    const lookPrepared = {
      summary: 'Detach the "Editorial Clean" Look',
      baseRevision: 'revision',
      changeSetId: 'change-set-look-2',
      operationDigest: 'e'.repeat(64),
      bindingDigest: 'f'.repeat(64),
      operationCount: 1,
    } as const satisfies HostRpcJson;
    const host = vi.fn<BrowserAgentHostCall>(async (method) =>
      method === 'read_project_context' ? frozenPage : lookPrepared,
    );
    let step = 0;
    const outcome = await runBoundedToolExchange(
      [],
      async (messages) => {
        if (step++ === 0)
          return response({
            tool_calls: [
              call('read', 'read_project_context', { domain: 'overview' }),
              call('too-early', 'look_detach', { instanceId: 'look-abcdefgh' }),
            ],
          });
        expect(lastToolResult(messages)).toEqual({
          ok: false,
          code: 'JOY_AGENT_CONTEXT_REQUIRED',
          repairable: true,
          applied: false,
        });
        return response({
          tool_calls: [call('detach', 'look_detach', { instanceId: 'look-abcdefgh' })],
        });
      },
      host,
      { allowedToolNames: ['read_project_context', 'look_detach'] },
    );
    expect(outcome).toEqual({ kind: 'prepared', proposal: lookPrepared });
    expect(host.mock.calls.map(([method]) => method)).toEqual([
      'read_project_context',
      'look_detach',
    ]);
  });
});
