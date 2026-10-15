// R2 (retest 02af4933): a run that hit the tool-call limit without a plan said
// "✔ Joy Agent finished" and "No plan was submitted"; the limit was overwritten by no-plan.
import { describe, expect, it } from 'vitest';
import { fixtureProject, runScriptedAgent } from './scripted-agent.test-helper.js';

describe('R2: a limit hit with no plan is named', () => {
  it('reports the tool-call limit and its value, not "no plan" or "finished"', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt: 'trim the clip to 5 seconds',
      steps: [
        { calls: Array.from({ length: 30 }, () => ({ toolName: 'read_selection', input: {} })) },
      ],
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).toBe(1);
    expect(result.changed).toBe(false);
    expect(output).toMatch(/Run stopped at the tool-call limit \(24 tool calls\)/);
    expect(output).not.toMatch(/No plan was submitted/);
    expect(output).not.toMatch(/finished in/);
  });
});
