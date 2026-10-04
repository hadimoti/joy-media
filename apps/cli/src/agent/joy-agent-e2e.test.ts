import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { runCli } from '../cli.js';
import * as providerRuntime from './provider.js';
import * as joyAgentRuntime from './joy-agent.js';
import { createDefaultProject } from '../utils/project-loader.js';

let isolatedHome: string;

beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'joy-agent-e2e-'));
  vi.stubEnv('USERPROFILE', isolatedHome);
  vi.stubEnv('HOME', isolatedHome);
  for (const key of [
    'KILO_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'JOY_MEDIA_SESSION_TOKEN',
  ])
    vi.stubEnv(key, '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

function stubbedCenteredTitleModel(titleX: number) {
  const responses: Array<{ toolName: string; input: unknown } | { text: string }> = [
    { toolName: 'joy_probe', input: { value: 'JOY_PROBE' } },
    {
      toolName: 'propose_timeline_operations',
      input: {
        operations: [
          {
            kind: 'trim',
            id: 'trim-main',
            clipId: 'main-clip',
            sourceInUs: 7_000_000,
            sourceOutUs: 17_000_000,
            dependsOn: [],
          },
        ],
      },
    },
    {
      toolName: 'propose_document_operations',
      input: {
        operations: [
          {
            kind: 'create-text',
            id: 'hello-title',
            text: 'Hello',
            startUs: 0,
            durationUs: 2_000_000,
            x: titleX,
            y: 0,
            dependsOn: [],
          },
          {
            kind: 'add-effect',
            id: 'crt-look',
            objectId: 'main-clip',
            effectId: 'crt',
            dependsOn: [],
          },
        ],
      },
    },
    {
      toolName: 'submit_plan',
      input: {
        checklist: [
          { kind: 'trim', clipId: 'main-clip', sourceInUs: 7_000_000, sourceOutUs: 17_000_000 },
          { kind: 'text', text: 'Hello', position: 'center' },
          { kind: 'look', clipId: 'main-clip', look: 'crt' },
        ],
      },
    },
    { text: 'Plan submitted with all requested changes.' },
  ];
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const response = responses[index++];
      if (!response)
        throw new Error(
          `Unexpected model call ${index}: ${JSON.stringify(options.prompt.flatMap((message) => (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool-call').map((part) => part.toolName) : [])))}`,
        );
      const isToolCall = 'toolName' in response;
      return {
        content: [
          isToolCall
            ? {
                type: 'tool-call',
                toolCallId: `mock-tool-${index}`,
                toolName: response.toolName,
                input: JSON.stringify(response.input),
              }
            : { type: 'text', text: response.text },
        ],
        finishReason: isToolCall
          ? { unified: 'tool-calls', raw: 'tool_calls' }
          : { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function writeAgentFixtureProject(file: string): void {
  const base = createDefaultProject('Agent e2e project', { id: 'agent-e2e-project' });
  const root = base.compositions.root!;
  const project = {
    ...base,
    assets: {
      'video-asset': {
        id: 'video-asset',
        kind: 'video' as const,
        displayName: 'Main video',
        descriptor: { mimeType: 'video/mp4', durationUs: 20_000_000 },
      },
    },
    compositions: {
      ...base.compositions,
      root: {
        ...root,
        durationUs: 20_000_000,
        tracks: root.tracks.map((track, index) =>
          index === 0
            ? {
                ...track,
                clips: [
                  {
                    id: 'main-clip',
                    kind: 'video' as const,
                    assetId: 'video-asset',
                    startUs: 0,
                    durationUs: 20_000_000,
                    sourceInUs: 0,
                  },
                ],
              }
            : track,
        ),
      },
    },
  };
  writeFileSync(file, JSON.stringify({ format: 'joy-media-project', revision: 4, project }));
}

describe('JOY Agent CLI edit verification end-to-end', () => {
  it('trims, adds a centered title, applies CRT, verifies the checklist, and saves', async () => {
    const projectFile = join(isolatedHome, 'agent-centered-e2e.json');
    writeAgentFixtureProject(projectFile);
    const model = stubbedCenteredTitleModel(0);
    const modelSpy = vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(model);
    const runAgent = joyAgentRuntime.runJoyAgent;
    let agentResult: Awaited<ReturnType<typeof joyAgentRuntime.runJoyAgent>> | undefined;
    const runSpy = vi.spyOn(joyAgentRuntime, 'runJoyAgent').mockImplementation(async (options) => {
      agentResult = await runAgent(options);
      return agentResult;
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const exitCode = await runCli([
        'agent',
        'run',
        'trim the clip to 7-17 s, add a centred title "Hello", apply a CRT look',
        '--project',
        projectFile,
        '--provider',
        'openrouter',
        '--api-key',
        'sk-test-REDACTED-0000',
        '--apply',
      ]);
      expect(exitCode).toBe(0);
      const saved = JSON.parse(readFileSync(projectFile, 'utf8')) as {
        revision: number;
        project: JoyProjectV1;
      };
      expect(saved.revision).toBe(5);
      expect(agentResult).toMatchObject({ applied: true, status: 'completed', errors: [] });
      expect(agentResult?.checklist).toHaveLength(3);
      expect(agentResult?.verified).toEqual(
        expect.arrayContaining([
          'Request: centered text',
          'Request: source trim 7000000–17000000 µs',
          'Request: crt look',
          'Trim main-clip: source 7000000–17000000 µs',
          'Text “Hello” centered',
          'Look main-clip: crt',
        ]),
      );
      const clips = saved.project.compositions.root!.tracks.flatMap((track) => track.clips);
      expect(clips.find((clip) => clip.id === 'main-clip')).toMatchObject({
        sourceInUs: 7_000_000,
        durationUs: 10_000_000,
        look: { preset: 'crt' },
      });
      expect(clips.some((clip) => clip.kind === 'caption')).toBe(true);
      const outputText = output.mock.calls.flat().join('\n');
      expect(outputText).toContain('Committed changes at project revision 5.');
      expect(outputText).toContain('Request: centered text');
      expect(outputText).toContain('Request: source trim 7000000');
      expect(outputText).toContain('Request: crt look');
      expect(modelSpy).toHaveBeenCalledOnce();
      expect(runSpy).toHaveBeenCalledOnce();
    } finally {
      modelSpy.mockRestore();
      runSpy.mockRestore();
      output.mockRestore();
    }
  });

  it('reports an off-center title as partial and leaves the project file unchanged', async () => {
    const projectFile = join(isolatedHome, 'agent-off-center-e2e.json');
    writeAgentFixtureProject(projectFile);
    const original = readFileSync(projectFile, 'utf8');
    const model = stubbedCenteredTitleModel(0.2);
    const modelSpy = vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(model);
    const runAgent = joyAgentRuntime.runJoyAgent;
    let agentResult: Awaited<ReturnType<typeof joyAgentRuntime.runJoyAgent>> | undefined;
    const runSpy = vi.spyOn(joyAgentRuntime, 'runJoyAgent').mockImplementation(async (options) => {
      agentResult = await runAgent(options);
      return agentResult;
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const exitCode = await runCli([
        'agent',
        'run',
        'trim the clip to 7-17 s, add a centred title "Hello", apply a CRT look',
        '--project',
        projectFile,
        '--provider',
        'openrouter',
        '--api-key',
        'sk-test-REDACTED-0000',
        '--apply',
      ]);
      expect(exitCode).toBe(1);
      expect(agentResult).toMatchObject({ applied: false, status: 'partial' });
      expect(readFileSync(projectFile, 'utf8')).toBe(original);
      expect(errors.mock.calls.flat().join('\n')).toContain('request asked for centered text');
    } finally {
      modelSpy.mockRestore();
      runSpy.mockRestore();
      output.mockRestore();
      errors.mockRestore();
    }
  });
});
