import { describe, expect, it } from 'vitest';
import { runBoundedToolExchange, validateBrowserProposal } from './bounded-tool-loop.js';

const proposal = {
  summary: 'Enable captions',
  operations: [{ id: 'caption', kind: 'caption.setBurnIn', enabled: true, dependsOn: [] }],
};
const response = (message: unknown) => JSON.stringify({ choices: [{ message }] });
const call = (name: string, args = '{}') => ({
  id: 'call-1',
  type: 'function',
  function: { name, arguments: args },
});

describe('mounted Worker bounded tool exchange', () => {
  it('returns typed proposal validation results to a second provider request', async () => {
    const requests: unknown[][] = [];
    let count = 0;
    const final = response({ content: JSON.stringify(proposal) });
    const result = await runBoundedToolExchange([], {}, async (messages) => {
      requests.push([...messages]);
      return count++ === 0
        ? response({ tool_calls: [call('validate_proposal', JSON.stringify(proposal))] })
        : final;
    });
    expect(result).toBe(final);
    const toolResult = requests[1]![1] as { role: string; content: string };
    expect(toolResult.role).toBe('tool');
    expect(JSON.parse(toolResult.content)).toEqual({ ok: true, proposal });
  });
  it('bounds repeated tool requests and rejects unknown tools', async () => {
    let count = 0;
    await expect(
      runBoundedToolExchange([], {}, async () => {
        count++;
        return response({ tool_calls: [call('read_project_context')] });
      }),
    ).rejects.toThrow('limit');
    expect(count).toBe(4);
    await expect(
      runBoundedToolExchange([], {}, async () => response({ tool_calls: [call('execute_shell')] })),
    ).rejects.toThrow('invalid');
  });
  it('rejects malformed operations before the compiler sees them', () => {
    expect(() => validateBrowserProposal({ summary: 'Bad', operations: [null] })).toThrow(
      'invalid',
    );
    expect(() =>
      validateBrowserProposal({
        summary: 'Bad',
        operations: [{ kind: 'caption.setBurnIn', enabled: true }],
      }),
    ).toThrow('invalid');
    expect(validateBrowserProposal(proposal)).toEqual(proposal);
  });
});
