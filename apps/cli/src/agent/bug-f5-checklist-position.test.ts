// F5: a checklist `position: "center"` item demanded positionX === 0 AND positionY === 0, so
// any horizontally centred caption that was not on the default line was refused (k3), and the
// schema offered no "bottom" value (k6 got a tool error).
import { describe, expect, it } from 'vitest';
import { fixtureProject, runScriptedAgent } from './scripted-agent.test-helper.js';

const prompt =
  'Add the caption "Welcome to JOY" from 0s to 4s, centred near the bottom of the frame.';

function steps(position: string) {
  return [
    {
      toolName: 'propose_document_operations',
      input: {
        operations: [
          {
            kind: 'create-text',
            id: 'en',
            text: 'Welcome to JOY',
            startUs: 0,
            durationUs: 4_000_000,
            y: 0.05,
          },
        ],
      },
    },
    {
      toolName: 'submit_plan',
      input: { checklist: [{ kind: 'text', text: 'Welcome to JOY', position }] },
    },
    { text: 'Done.' },
  ];
}

describe('F5: checklist text positions', () => {
  it('"center" verifies a horizontally centred caption below the default line (k3)', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: steps('center'),
    });
    expect(result.stderr).not.toMatch(/Checklist not verified/);
    expect(result.exitCode).toBe(0);
  });

  it('accepts and verifies "bottom"', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: steps('bottom'),
    });
    expect(result.exitCode).toBe(0);
  });

  it('still refuses "top" for a caption at the bottom', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: steps('top'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.changed).toBe(false);
  });
});
