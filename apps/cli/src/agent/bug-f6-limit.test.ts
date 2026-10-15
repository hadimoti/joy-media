// F6: a complete, valid plan whose submit_plan call landed on the run's last allowed tool
// call was reported as "Prepared 3 change(s) for review… Nothing was applied" with no reason
// (o1: 18 steps, tool-call limit 24).
import { describe, expect, it } from 'vitest';
import { fixtureProject, rootClips, runScriptedAgent } from './scripted-agent.test-helper.js';

const prompt = 'apply the CRT look to the clip';
const look = {
  toolName: 'propose_document_operations',
  input: { operations: [{ kind: 'add-effect', id: 'crt', objectId: 'clip-a', effectId: 'crt' }] },
};
const reads = (count: number) => ({
  calls: Array.from({ length: count }, () => ({ toolName: 'read_selection', input: {} })),
});
const submit = {
  toolName: 'submit_plan',
  input: { checklist: [{ kind: 'look', clipId: 'clip-a', look: 'crt' }] },
};

describe('F6: tool-call limit on the submitting step', () => {
  it('applies a verified plan whose submit_plan was the last allowed tool call', async () => {
    // 1 + 22 + 1 = 24 tool calls = DEFAULT_JOY_AGENT_LIMITS.maxToolCalls.
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: [look, reads(22), submit, { text: 'never reached' }],
    });
    expect(result.exitCode).toBe(0);
    expect(rootClips(result.saved)[0]).toMatchObject({ look: { preset: 'crt' } });
  });

  it('says which limit stopped the run when the plan was not final', async () => {
    // The plan is submitted, then the model keeps staging, then hits the limit.
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: [
        look,
        submit,
        reads(21),
        {
          toolName: 'propose_document_operations',
          input: {
            operations: [{ kind: 'add-effect', id: 'bw', objectId: 'clip-a', effectId: 'bw' }],
          },
        },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.changed).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/tool-call limit/);
  });
});
