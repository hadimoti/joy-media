import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
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

/** Hosted mode resolves through the real provider path with a session token and a stubbed catalog. */
function useHostedSession(): void {
  vi.stubEnv('JOY_MEDIA_SESSION_TOKEN', 'joy-session-test-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/models'))
        return new Response(
          JSON.stringify({ models: [{ id: 'openrouter/free', isDefault: true, vision: false }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

function jsonRecords(lines: unknown[][]): Record<string, unknown>[] {
  return lines
    .flat()
    .map((line) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((record): record is Record<string, unknown> => record !== undefined);
}

describe('agent run in hosted mode (joy-hosted)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the project summary and selection without a TypeError (bug 1)', async () => {
    useHostedSession();
    const projectFile = join(home, 'hosted-read.json');
    writeProject(projectFile);
    const createModel = vi
      .spyOn(providerRuntime, 'createModelFromConfig')
      .mockReturnValue(scriptedAgentModel(readSteps));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCli([
      'agent',
      'run',
      'inspect the project',
      '--project',
      projectFile,
      '--provider',
      'joy-hosted',
      '--model',
      'openrouter/free',
    ]);

    expect(createModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'joy-hosted', apiKey: 'joy-session-test-token' }),
    );
    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Observation: read_project_summary {"projectId":"trace-project"');
    expect(text).toContain('Observation: read_selection {"selectedClipIds":[]');
    expect(text).not.toContain('TypeError');
  });

  it('reports staged:false from submit_plan when the only proposal was rejected (bug 14)', async () => {
    useHostedSession();
    const projectFile = join(home, 'hosted-plan.json');
    writeProject(projectFile);
    vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(
      scriptedAgentModel([
        [
          {
            type: 'tool-call',
            toolName: 'propose_timeline_operations',
            input: {
              operations: [
                {
                  kind: 'trim',
                  id: 'trim-ghost',
                  clipId: 'ghost-clip',
                  sourceInUs: 0,
                  sourceOutUs: 1_000_000,
                  dependsOn: [],
                },
              ],
            },
          },
        ],
        [
          {
            type: 'tool-call',
            toolName: 'submit_plan',
            input: {
              checklist: [
                { kind: 'trim', clipId: 'ghost-clip', sourceInUs: 0, sourceOutUs: 1_000_000 },
              ],
            },
          },
        ],
        [{ type: 'text', text: 'Plan submitted.' }],
      ]),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCli([
      'agent',
      'run',
      'trim the ghost clip',
      '--project',
      projectFile,
      '--provider',
      'joy-hosted',
      '--model',
      'openrouter/free',
      '--json',
    ]);

    const submit = jsonRecords(output.mock.calls).find(
      (record) => record.type === 'observation' && record.name === 'submit_plan',
    );
    expect(submit?.value).toMatchObject({ staged: false, willApplyOnFinish: false });
    expect(JSON.stringify(submit?.value)).toContain(
      'Checklist references unknown clip ghost-clip.',
    );
  });

  it('shows the gateway error code and message when the hosted service fails (L2)', async () => {
    useHostedSession();
    const projectFile = join(home, 'hosted-503.json');
    writeProject(projectFile);
    const body =
      '{"error":{"code":"JOY_AGENT_UPSTREAM_AUTH_FAILED","message":"Server provider credential rejected"}}';
    vi.spyOn(providerRuntime, 'createModelFromConfig').mockReturnValue(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new APICallError({
            message: 'Service Unavailable',
            url: 'https://joyst.ir/api/v1/agent/chat/completions',
            requestBodyValues: {},
            statusCode: 503,
            responseBody: body,
            isRetryable: false,
          });
        },
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const code = await runCli([
      'agent',
      'run',
      'say hi',
      '--project',
      projectFile,
      '--provider',
      'joy-hosted',
      '--model',
      'openrouter/free',
      '--debug',
    ]);

    expect(code).toBe(1);
    const text = errors.mock.calls.flat().join('\n');
    expect(text).toContain(
      'JOY hosted service: Server provider credential rejected (JOY_AGENT_UPSTREAM_AUTH_FAILED, HTTP 503)',
    );
    expect(text).toContain('Debug detail:');
    expect(text).not.toContain('joy-session-test-token');
  });
});
