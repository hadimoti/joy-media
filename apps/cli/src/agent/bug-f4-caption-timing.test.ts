// F4: requested caption times were never checked. In h3 the model dropped the start times,
// both captions landed at 0-4 s on top of each other, and the run exited 0 with "Verified".
import { describe, expect, it } from 'vitest';
import { fixtureProject, rootClips, runScriptedAgent } from './scripted-agent.test-helper.js';

const persian = 'سلام دنیا، به جوی خوش آمدید';
const prompt = `Add captions to this video without changing the video itself: "Welcome to JOY" from 0s to 4s, then the Persian caption "${persian}" from 4s to 8s. Both should be centred horizontally near the bottom of the frame.`;

function captionSteps(secondStartUs: number | undefined) {
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
          },
          {
            kind: 'create-text',
            id: 'fa',
            text: persian,
            ...(secondStartUs === undefined ? {} : { startUs: secondStartUs }),
            durationUs: 4_000_000,
          },
        ],
      },
    },
    {
      toolName: 'submit_plan',
      input: {
        checklist: [
          { kind: 'text', text: 'Welcome to JOY' },
          { kind: 'text', text: persian },
        ],
      },
    },
    { text: 'Captions added.' },
  ];
}

describe('F4: caption timing is verified', () => {
  it('refuses overlapping captions when the request gave 0-4 s and 4-8 s (h3)', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: captionSteps(undefined),
    });
    expect(result.exitCode).toBe(1);
    expect(result.changed).toBe(false);
    expect(result.stderr).toMatch(/4s to 8s|4000000/);
  });

  it('accepts the captions when they are where the request asked', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: captionSteps(4_000_000),
    });
    expect(result.exitCode).toBe(0);
    const captions = rootClips(result.saved).filter((clip) => clip.kind === 'caption');
    expect(captions.map((clip) => [clip.startUs, clip.durationUs])).toEqual([
      [0, 4_000_000],
      [4_000_000, 4_000_000],
    ]);
  });

  it('checks a checklist start hint instead of discarding it', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt: 'add the caption "Hello" ',
      steps: [
        {
          toolName: 'propose_document_operations',
          input: {
            operations: [
              {
                kind: 'create-text',
                id: 'hello',
                text: 'Hello',
                startUs: 0,
                durationUs: 2_000_000,
              },
            ],
          },
        },
        {
          toolName: 'submit_plan',
          input: { checklist: [{ kind: 'text', text: 'Hello', timelineStartUs: 5_000_000 }] },
        },
        { text: 'Done.' },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Hello/);
  });
});
