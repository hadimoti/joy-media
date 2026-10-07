import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { runCli } from '../cli.js';
import * as providerRuntime from './provider.js';
import { createDefaultProject } from '../utils/project-loader.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'joy-agent-trace-'));
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('HOME', home);
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
  rmSync(home, { recursive: true, force: true });
});

type Step = ReadonlyArray<
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly toolName: string; readonly input?: unknown }
>;

/** A scripted offline model; records the tool names offered on each call. */
function scriptedAgentModel(steps: readonly Step[], offeredTools: string[][] = []) {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      offeredTools.push((options.tools ?? []).map((tool) => tool.name));
      const parts = steps[index++] ?? [{ type: 'text' as const, text: 'Done.' }];
      const toolCall = parts.some((part) => part.type === 'tool-call');
      return {
        content: parts.map((part, partIndex) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'tool-call' as const,
                toolCallId: `call-${index}-${partIndex}`,
                toolName: part.toolName,
                input: JSON.stringify(part.input ?? {}),
              },
        ),
        finishReason: toolCall
          ? { unified: 'tool-calls' as const, raw: 'tool_calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function writeProject(file: string): void {
  const project = createDefaultProject('Trace project', { id: 'trace-project' });
  writeFileSync(file, JSON.stringify({ format: 'joy-media-project', revision: 1, project }));
}

const readSteps: Step[] = [
  [{ type: 'tool-call', toolName: 'read_project_summary' }],
  [{ type: 'tool-call', toolName: 'read_selection' }],
  [{ type: 'tool-call', toolName: 'read_brief' }],
  [{ type: 'text', text: 'Inspection finished.' }],
];

describe('agent run transcript', () => {
  it('prints observations for project reads and a Tool error line for a failed tool', async () => {
    const projectFile = join(home, 'trace.json');
    writeProject(projectFile);
    vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(
      scriptedAgentModel(readSteps),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCli([
      'agent',
      'run',
      'inspect the project',
      '--project',
      projectFile,
      '--provider',
      'openrouter',
      '--api-key',
      'sk-test-REDACTED-0000',
    ]);

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Observation: read_project_summary {"projectId":"trace-project"');
    expect(text).toContain('Observation: read_selection {"selectedClipIds":[]');
    expect(text).toContain('Tool error: read_brief Error: JOY_AGENT_UNAVAILABLE');
    expect(text).not.toContain('TypeError');
  });

  it('emits a tool_error record in --json output', async () => {
    const projectFile = join(home, 'trace-json.json');
    writeProject(projectFile);
    vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(
      scriptedAgentModel(readSteps),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCli([
      'agent',
      'run',
      'inspect the project',
      '--project',
      projectFile,
      '--provider',
      'openrouter',
      '--api-key',
      'sk-test-REDACTED-0000',
      '--json',
    ]);

    const records = output.mock.calls
      .flat()
      .map((line) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((record) => record !== undefined);
    expect(records).toContainEqual({
      type: 'tool_error',
      name: 'read_brief',
      value: { error: 'Error: JOY_AGENT_UNAVAILABLE' },
    });
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'observation', name: 'read_project_summary' }),
    );
  });

  it('prints model text written between tool calls (frame observations are not dropped)', async () => {
    const projectFile = join(home, 'trace-text.json');
    writeProject(projectFile);
    vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(
      scriptedAgentModel([
        [
          { type: 'text', text: 'Observed 08.000 = frame 240 with 4 bars.' },
          { type: 'tool-call', toolName: 'read_selection' },
        ],
        [{ type: 'text', text: 'Inspection finished.' }],
      ]),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCli([
      'agent',
      'run',
      'inspect the project',
      '--project',
      projectFile,
      '--provider',
      'openrouter',
      '--api-key',
      'sk-test-REDACTED-0000',
    ]);

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Model: Observed 08.000 = frame 240 with 4 bars.');
    expect(text.indexOf('Model: Observed')).toBeLessThan(text.indexOf('Tool call: read_selection'));
    expect(text.match(/Inspection finished\./g)).toHaveLength(1);
  });

  it('honours --vision with --allow-frames for openrouter/free and warns once', async () => {
    const projectFile = join(home, 'trace-vision.json');
    writeProject(projectFile);
    const runWith = async (extra: string[]) => {
      const offered: string[][] = [];
      vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(
        scriptedAgentModel([[{ type: 'text', text: 'Looked.' }]], offered),
      );
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await runCli([
        'agent',
        'run',
        'check frame 8',
        '--project',
        projectFile,
        '--provider',
        'openrouter',
        '--model',
        'openrouter/free',
        '--api-key',
        'sk-test-REDACTED-0000',
        '--allow-frames',
        ...extra,
      ]);
      const text = [...output.mock.calls, ...errors.mock.calls].flat().join('\n');
      vi.restoreAllMocks();
      return { offered: offered.flat(), text };
    };

    const explicit = await runWith(['--vision']);
    expect(explicit.offered).toContain('read_frame');
    expect(explicit.text).toContain(
      'openrouter/free routes to a model that may not support images',
    );
    expect(explicit.text).not.toContain('frame inspection skipped');

    const implicit = await runWith([]);
    expect(implicit.offered).not.toContain('read_frame');
    expect(implicit.text).toContain('frame inspection skipped: model has no vision');
  });
});
