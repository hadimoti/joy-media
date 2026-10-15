// F2: speed changes were impossible: playbackRate exists in the schema and the renderer, but
// no agent operation or CLI command could set it (d4, o4). The refusal was then reported as
// "No plan was submitted after the single retry" even though no retry happened.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { runCli } from '../cli.js';
import { fixtureProject, rootClips, runScriptedAgent } from './scripted-agent.test-helper.js';

const prompt =
  'Speed this clip up: I want source 0-20s to play at 2x speed so it lasts 10 seconds on the timeline starting at 0, and nothing after that.';

describe('F2: speed changes', () => {
  it('set-speed after a trim gives a 2x clip 10 s long', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: [
        {
          toolName: 'propose_timeline_operations',
          input: {
            operations: [
              {
                kind: 'trim',
                id: 't',
                clipId: 'clip-a',
                sourceInUs: 0,
                sourceOutUs: 20_000_000,
                timelineStartUs: 0,
              },
              { kind: 'set-speed', id: 's', clipId: 'clip-a', rate: 2 },
            ],
          },
        },
        {
          toolName: 'submit_plan',
          input: {
            checklist: [
              { kind: 'trim', clipId: 'clip-a', sourceInUs: 0, sourceOutUs: 20_000_000 },
              { kind: 'speed', clipId: 'clip-a', rate: 2 },
            ],
          },
        },
        { text: 'Done.' },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(rootClips(result.saved)[0]).toMatchObject({
      sourceInUs: 0,
      durationUs: 10_000_000,
      playbackRate: 2,
    });
  });

  it('refuses a plan that ignores the requested 2x speed', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: [
        {
          toolName: 'propose_timeline_operations',
          input: {
            operations: [
              { kind: 'trim', id: 't', clipId: 'clip-a', sourceInUs: 0, sourceOutUs: 10_000_000 },
            ],
          },
        },
        {
          toolName: 'submit_plan',
          input: {
            checklist: [{ kind: 'trim', clipId: 'clip-a', sourceInUs: 0, sourceOutUs: 10_000_000 }],
          },
        },
        { text: 'Done.' },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/2x speed/);
  });

  it('an honest refusal does not claim a retry happened', async () => {
    const result = await runScriptedAgent({
      project: fixtureProject({}),
      prompt,
      steps: [{ text: 'Changing playback speed is not possible.' }],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toMatch(/single retry/);
    expect(result.stderr).toMatch(/No plan was submitted/);
  });

  it('`joy-media timeline speed --clip <id> --rate 2` sets the speed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'joy-speed-'));
    const file = join(home, 'project.json');
    writeFileSync(
      file,
      JSON.stringify({ format: 'joy-media-project', revision: 1, project: fixtureProject({}) }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const exitCode = await runCli([
        'timeline',
        'speed',
        '--project',
        file,
        '--clip',
        'clip-a',
        '--rate',
        '2',
      ]);
      expect(exitCode).toBe(0);
      const saved = (JSON.parse(readFileSync(file, 'utf8')) as { project: JoyProjectV1 }).project;
      expect(rootClips(saved)[0]).toMatchObject({ playbackRate: 2, durationUs: 15_000_000 });
    } finally {
      log.mockRestore();
      error.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
