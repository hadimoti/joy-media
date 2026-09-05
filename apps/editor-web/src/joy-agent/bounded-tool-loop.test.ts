import { describe, expect, it, vi } from 'vitest';
import * as agentTools from '@joy-media/agent-tools';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { compileJoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';
import {
  BROWSER_AGENT_TOOLS,
  createBrowserAgentTools,
  runBoundedToolExchange,
  validateBrowserProposal,
} from './bounded-tool-loop.js';
import { listModelVisibleJoyEditorOperations } from './editor-operation-registry.js';

const proposal = {
  summary: 'Move clip',
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
const context = {
  projectId: 'project',
  revision: 'revision',
  compositionId: 'composition',
  trackIds: ['track'],
  selectedClipIds: ['clip'],
  playheadUs: 0,
  clips: [{ id: 'clip', trackId: 'track', startUs: 0, durationUs: 1000 }],
  assets: [],
  omitted: [],
};
const response = (message: unknown) => JSON.stringify({ choices: [{ message }] });
const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const lastResult = (messages: readonly unknown[]) =>
  JSON.parse((messages.at(-1) as { content: string }).content);

describe('mounted Worker bounded semantic tool exchange', () => {
  it('advertises the package-generated schema for exactly the displayed operation kinds', () => {
    const proposalTool = BROWSER_AGENT_TOOLS.find(
      (tool) => tool.function.name === 'validate_proposal',
    );
    expect(proposalTool).toBeDefined();
    const parameters = proposalTool?.function.parameters;
    if (parameters === undefined) throw new Error('validate_proposal tool is missing parameters');
    expect(parameters).toEqual(agentTools.createModelVisibleJoyCodeProposalParameters());
    expect(parameters).toMatchObject({
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
  });

  it('withholds validation when no verified operation schema is available', () => {
    expect(createBrowserAgentTools(undefined).map((tool) => tool.function.name)).toEqual([
      'read_project_context',
    ]);
  });

  it('rejects a canonical operation when the model-visible registry no longer allows it', () => {
    expect(validateBrowserProposal(proposal)).toEqual(proposal);
    const visibleKinds = vi
      .spyOn(agentTools, 'listModelVisibleJoyCodeOperationKinds')
      .mockReturnValue(['timeline.trimClip']);
    try {
      expect(() => validateBrowserProposal(proposal)).toThrow('invalid proposal operations');
      expect(visibleKinds).toHaveBeenCalled();
    } finally {
      visibleKinds.mockRestore();
    }
  });

  it('feeds context to the model, repairs an unknown clip, stages and binds its final decision', async () => {
    let count = 0;
    const staged: unknown[] = [];
    const original = JSON.stringify(context);
    const result = await runBoundedToolExchange(
      [],
      context,
      async (messages) => {
        switch (count++) {
          case 0:
            return response({ tool_calls: [call('read', 'read_project_context')] });
          case 1:
            expect(lastResult(messages)).toMatchObject({
              ok: true,
              context: { selectedClipIds: ['clip'], revision: 'revision' },
            });
            return response({
              tool_calls: [
                call('bad', 'validate_proposal', {
                  ...proposal,
                  operations: [{ ...proposal.operations[0], clipId: 'missing' }],
                }),
              ],
            });
          case 2:
            expect(lastResult(messages)).toEqual({
              ok: false,
              code: 'JOY_AGENT_UNKNOWN_CLIP',
              repairable: true,
              applied: false,
            });
            expect(staged).toEqual([]);
            return response({ tool_calls: [call('repair', 'validate_proposal', proposal)] });
          default:
            expect(lastResult(messages)).toMatchObject({
              ok: true,
              staged: true,
              applied: false,
              baseRevision: 'revision',
              proposal,
            });
            return response({ content: JSON.stringify(proposal) });
        }
      },
      { onStaged: (value) => staged.push(value) },
    );
    expect(count).toBe(4);
    expect(staged).toEqual([proposal]);
    expect(JSON.stringify(context)).toBe(original);
    expect(JSON.parse(result).choices[0].message.content).toBe(JSON.stringify(proposal));
  });

  it('rejects immediate finals and finals that bypass staged operations', async () => {
    await expect(
      runBoundedToolExchange([], context, async () =>
        response({ content: JSON.stringify(proposal) }),
      ),
    ).rejects.toThrow('before context');
    let step = 0;
    await expect(
      runBoundedToolExchange([], context, async () => {
        if (step++ === 0) return response({ tool_calls: [call('read', 'read_project_context')] });
        if (step === 2)
          return response({ tool_calls: [call('stage', 'validate_proposal', proposal)] });
        return response({
          content: JSON.stringify({ ...proposal, summary: 'Unvalidated replacement' }),
        });
      }),
    ).rejects.toThrow('differs');
  });

  it('bounds steps, total calls, duplicate ids and invalid tools', async () => {
    let count = 0;
    await expect(
      runBoundedToolExchange([], context, async () =>
        response({ tool_calls: [call(`read-${count++}`, 'read_project_context')] }),
      ),
    ).rejects.toThrow('limit');
    expect(count).toBe(4);
    await expect(
      runBoundedToolExchange([], context, async () =>
        response({
          tool_calls: Array.from({ length: 9 }, (_, i) => call(`${i}`, 'read_project_context')),
        }),
      ),
    ).rejects.toThrow('limit');
    await expect(
      runBoundedToolExchange([], context, async () =>
        response({
          tool_calls: [call('same', 'read_project_context'), call('same', 'read_project_context')],
        }),
      ),
    ).rejects.toThrow('invalid');
    for (const tool of [null, call('shell', 'execute_shell')])
      await expect(
        runBoundedToolExchange([], context, async () => response({ tool_calls: [tool] })),
      ).rejects.toThrow('invalid');
  });

  it('does not stage a provider response received after cancellation', async () => {
    const controller = new AbortController();
    let staged = false;
    await expect(
      runBoundedToolExchange(
        [],
        context,
        async () => {
          controller.abort();
          return response({
            tool_calls: [
              call('read', 'read_project_context'),
              call('stage', 'validate_proposal', proposal),
            ],
          });
        },
        {
          signal: controller.signal,
          onStaged: () => {
            staged = true;
          },
        },
      ),
    ).rejects.toThrow();
    expect(staged).toBe(false);
  });

  it('returns bounded repair feedback for malformed operations and requires prior context', async () => {
    let count = 0;
    await expect(
      runBoundedToolExchange([], context, async (messages) => {
        if (count++ === 0)
          return response({ tool_calls: [call('early', 'validate_proposal', proposal)] });
        expect(lastResult(messages)).toMatchObject({
          code: 'JOY_AGENT_CONTEXT_REQUIRED',
          repairable: true,
        });
        return response({ content: JSON.stringify(proposal) });
      }),
    ).rejects.toThrow('before context');
    expect(() => validateBrowserProposal({ summary: 'Bad', operations: [null] })).toThrow(
      'invalid',
    );
    expect(validateBrowserProposal(proposal)).toEqual(proposal);
  });

  it('resolves a created title output before a dependent motion operation, even when array order is reversed', async () => {
    const createdContext = {
      ...context,
      visualObjects: [],
    };
    const symbolicProposal = {
      summary: 'Create and animate a title',
      operations: [
        {
          id: 'animate',
          dependsOn: ['title'],
          kind: 'motion.setKeyframe',
          binding: {
            ownerKind: 'visual-object',
            ownerRef: { kind: 'visual-object', ref: 'title-output' },
            propertyId: 'opacity',
            timeDomain: 'composition',
          },
          key: { kind: 'scalar', timeUs: 500_000, value: 0.5, interpolation: 'linear' },
        },
        {
          id: 'title',
          dependsOn: [],
          kind: 'text.insertTemplate',
          templateId: 'clean-title',
          content: 'Title',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
          outputRef: { kind: 'visual-object', ref: 'title-output' },
        },
      ],
    };
    let step = 0;
    const staged: unknown[] = [];
    const result = await runBoundedToolExchange(
      [],
      createdContext,
      async (messages) => {
        if (step++ === 0) return response({ tool_calls: [call('read', 'read_project_context')] });
        if (step === 2)
          return response({ tool_calls: [call('stage', 'validate_proposal', symbolicProposal)] });
        expect(lastResult(messages)).toMatchObject({ ok: true, staged: true });
        return response({ content: JSON.stringify(symbolicProposal) });
      },
      { planId: 'review', onStaged: (proposal) => staged.push(proposal) },
    );
    expect(staged[0]).toMatchObject({
      operations: [
        { id: 'animate', binding: { ownerId: 'text-clean-title-review-1' } },
        { id: 'title', outputRef: { ref: 'title-output' } },
      ],
    });
    expect(JSON.parse(result).choices[0].message.content).toContain('text-clean-title-review-1');
    const canonical = compileJoyCodeCompoundDraft({
      planId: 'review',
      baseRevision: 'revision',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: [],
      operations:
        staged[0] && typeof staged[0] === 'object'
          ? (staged[0] as { operations: never[] }).operations
          : [],
    });
    expect(canonical.ok).toBe(true);
  });

  it('rejects an output reference that is not declared by a dependency', async () => {
    const invalid = {
      summary: 'Animate unknown output',
      operations: [
        {
          id: 'animate',
          dependsOn: [],
          kind: 'motion.setKeyframe',
          binding: {
            ownerKind: 'visual-object',
            ownerRef: { kind: 'visual-object', ref: 'missing-output' },
            propertyId: 'opacity',
            timeDomain: 'composition',
          },
          key: { kind: 'scalar', timeUs: 0, value: 0.5, interpolation: 'linear' },
        },
      ],
    };
    let count = 0;
    await expect(
      runBoundedToolExchange(
        [],
        { ...context, visualObjects: [] },
        async (messages) => {
          const step = count++;
          if (step === 0) return response({ tool_calls: [call('read', 'read_project_context')] });
          if (step === 1)
            return response({ tool_calls: [call('stage', 'validate_proposal', invalid)] });
          if (step === 2) {
            expect(lastResult(messages)).toMatchObject({
              code: 'JOY_AGENT_UNKNOWN_OUTPUT_REF',
              repairable: true,
            });
            return response({ tool_calls: [call('repair', 'validate_proposal', proposal)] });
          }
          expect(lastResult(messages)).toMatchObject({ ok: true, staged: true });
          return response({ content: JSON.stringify(proposal) });
        },
        { planId: 'review' },
      ),
    ).resolves.toBeDefined();
  });
});
