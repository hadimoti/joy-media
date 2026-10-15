// F3: an existing title could not be read or edited, so "actually make the title smaller and
// move it to the bottom" was impossible (k6 invented a new title "f-k6"; h6 gave up).
import { describe, expect, it } from 'vitest';
import { CliJoyAgentToolBridge } from './bridge.js';
import { fixtureProject, rootClips, runScriptedAgent } from './scripted-agent.test-helper.js';

const project = () =>
  fixtureProject({
    clips: [
      {
        id: 'clip-a',
        assetId: 'asset-a',
        startUs: 0,
        durationUs: 10_000_000,
        sourceInUs: 7_000_000,
        look: 'crt',
      },
    ],
    texts: [{ id: 'title', text: 'JOY Media Test', startUs: 0, durationUs: 10_000_000, y: -0.3 }],
  });
const prompt = 'actually make the title smaller and move it to the bottom';

describe('F3: existing text is readable and editable', () => {
  it('read_timeline_window shows the caption text, size and position', async () => {
    const bridge = new CliJoyAgentToolBridge(project(), 1);
    const window = (await bridge.readTimelineWindow({ startUs: 0, endUs: 10_000_000 })) as {
      clips: Array<Record<string, unknown>>;
    };
    expect(window.clips.find((clip) => clip.clipId === 'text-title')).toMatchObject({
      text: 'JOY Media Test',
      size: 1,
      y: -0.3,
    });
  });

  it('update-text changes size and y of the existing title in place', async () => {
    const result = await runScriptedAgent({
      project: project(),
      prompt,
      steps: [
        {
          toolName: 'propose_document_operations',
          input: {
            operations: [
              { kind: 'update-text', id: 'smaller', objectId: 'text-title', size: 0.6, y: 0.05 },
            ],
          },
        },
        {
          toolName: 'submit_plan',
          input: { checklist: [{ kind: 'text', text: 'JOY Media Test', position: 'bottom' }] },
        },
        { text: 'Title is smaller and at the bottom.' },
      ],
    });
    expect(result.exitCode).toBe(0);
    const captions = rootClips(result.saved).filter((clip) => clip.kind === 'caption');
    expect(captions).toHaveLength(1);
    expect(captions[0]).toMatchObject({
      id: 'text-title',
      style: { fontSize: 0.6, positionY: -0.05 },
    });
  });

  it('set-property on a caption clip (what models try first) works too', async () => {
    const result = await runScriptedAgent({
      project: project(),
      prompt,
      steps: [
        {
          toolName: 'propose_document_operations',
          input: {
            operations: [
              {
                kind: 'set-property',
                id: 'p1',
                objectId: 'text-title',
                property: 'size',
                value: 0.5,
              },
              { kind: 'set-property', id: 'p2', objectId: 'text-title', property: 'y', value: 0 },
            ],
          },
        },
        {
          toolName: 'submit_plan',
          input: { checklist: [{ kind: 'text', text: 'JOY Media Test' }] },
        },
        { text: 'Done.' },
      ],
    });
    if (result.exitCode !== 0) console.info('DBG', result.stdout, '\nERR', result.stderr);
    expect(result.exitCode).toBe(0);
    expect(rootClips(result.saved).find((clip) => clip.id === 'text-title')).toMatchObject({
      style: { fontSize: 0.5, positionY: 0 },
    });
  });

  it('refuses a "smaller" request when the title did not get smaller (k6 pattern)', async () => {
    const result = await runScriptedAgent({
      project: project(),
      prompt,
      steps: [
        {
          toolName: 'propose_document_operations',
          input: {
            operations: [
              {
                kind: 'create-text',
                id: 'new',
                text: 'f-k6',
                size: 1.2,
                y: 0.05,
                durationUs: 10_000_000,
              },
            ],
          },
        },
        { toolName: 'submit_plan', input: { checklist: [{ kind: 'text', text: 'f-k6' }] } },
        { text: 'Done.' },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.changed).toBe(false);
    expect(result.stderr).toMatch(/smaller/);
  });
});
