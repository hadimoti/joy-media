import { describe, expect, it } from 'vitest';
import { runBoundedToolExchange, validateBrowserProposal } from './bounded-tool-loop.js';

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
});
