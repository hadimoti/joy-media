/**
 * Offline harness for agent bug repros: a scripted fake model (no network) drives the real
 * `joy-media agent run` code path against a project file in an isolated HOME.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { runCli } from '../cli.js';
import * as providerRuntime from './provider.js';
import * as joyAgentRuntime from './joy-agent.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { createTextClip } from '../render/text-clip.js';

export type ScriptStep =
  | { readonly toolName: string; readonly input: unknown }
  | { readonly calls: readonly { readonly toolName: string; readonly input: unknown }[] }
  | { readonly text: string };

export function scriptedModel(steps: readonly ScriptStep[]): MockLanguageModelV3 {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[index++] ?? { text: 'Done.' };
      const calls = 'calls' in step ? step.calls : 'toolName' in step ? [step] : [];
      return {
        content:
          calls.length > 0
            ? calls.map((call, n) => ({
                type: 'tool-call' as const,
                toolCallId: `scripted-${index}-${n}`,
                toolName: call.toolName,
                input: JSON.stringify(call.input),
              }))
            : [{ type: 'text' as const, text: 'text' in step ? step.text : 'Done.' }],
        finishReason:
          calls.length > 0
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

export interface FixtureClip {
  readonly id: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs?: number;
  readonly look?: 'crt' | 'bw' | 'warm' | 'cool';
}

export interface FixtureText {
  readonly id: string;
  readonly text: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly y?: number;
  readonly size?: number;
}

/** A 1920x1080/30 fps project with video clips on track-v1 and optional caption texts. */
export function fixtureProject(options: {
  readonly assets?: Record<string, number>;
  readonly clips?: readonly FixtureClip[];
  readonly texts?: readonly FixtureText[];
}): JoyProjectV1 {
  const base = createDefaultProject('Scripted repro', { id: 'scripted-repro' });
  const root = base.compositions.root!;
  const assets = Object.fromEntries(
    Object.entries(options.assets ?? { 'asset-a': 30_000_000 }).map(([id, durationUs]) => [
      id,
      {
        id,
        kind: 'video' as const,
        displayName: `${id}.mp4`,
        hasAudio: true,
        descriptor: { mimeType: 'video/mp4', durationUs },
      },
    ]),
  );
  const clips = (
    options.clips ?? [{ id: 'clip-a', assetId: 'asset-a', startUs: 0, durationUs: 30_000_000 }]
  ).map((clip) => ({
    id: clip.id,
    kind: 'video' as const,
    assetId: clip.assetId,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    sourceInUs: clip.sourceInUs ?? 0,
    ...(clip.look ? { look: { preset: clip.look } } : {}),
  }));
  const texts = (options.texts ?? []).map((text) =>
    createTextClip({
      id: text.id,
      text: text.text,
      startUs: text.startUs,
      durationUs: text.durationUs,
      ...(text.y === undefined ? {} : { y: text.y }),
      ...(text.size === undefined ? {} : { size: text.size }),
    }),
  );
  const tracks = root.tracks.map((track, index) =>
    index === 0 ? { ...track, clips } : track,
  ) as unknown as JoyProjectV1['compositions'][string]['tracks'];
  const allTracks =
    texts.length === 0
      ? tracks
      : ([
          ...tracks,
          {
            id: 'track-captions',
            kind: 'caption',
            family: 'visual',
            name: 'Captions',
            order: tracks.length,
            enabled: true,
            locked: false,
            clips: texts.map((text) => text.clip),
          },
        ] as unknown as typeof tracks);
  const durationUs = Math.max(1, ...clips.map((clip) => clip.startUs + clip.durationUs));
  return {
    ...base,
    assets,
    captionDocuments: Object.fromEntries(texts.map((text) => [text.document.id, text.document])),
    compositions: {
      ...base.compositions,
      root: { ...root, durationUs, tracks: allTracks },
    },
  } as JoyProjectV1;
}

export interface ScriptedRunResult {
  readonly exitCode: number;
  readonly saved: JoyProjectV1;
  readonly changed: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly agentResult: Awaited<ReturnType<typeof joyAgentRuntime.runJoyAgent>> | undefined;
}

/** Runs `joy-media agent run <prompt> --apply` with the scripted model; nothing leaves the box. */
export async function runScriptedAgent(input: {
  readonly project: JoyProjectV1;
  readonly prompt: string;
  readonly steps: readonly ScriptStep[];
  readonly extraArgs?: readonly string[];
}): Promise<ScriptedRunResult> {
  const home = mkdtempSync(join(tmpdir(), 'joy-scripted-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('JOY_SCRIPTED_TEST_KEY', 'test-placeholder-not-a-key');
  const file = join(home, 'project.json');
  const original = JSON.stringify({
    format: 'joy-media-project',
    revision: 4,
    project: input.project,
  });
  writeFileSync(file, original);
  const modelSpy = vi
    .spyOn(providerRuntime, 'createModelFromConfig')
    .mockReturnValue(scriptedModel(input.steps));
  const runAgent = joyAgentRuntime.runJoyAgent;
  let agentResult: ScriptedRunResult['agentResult'];
  const runSpy = vi.spyOn(joyAgentRuntime, 'runJoyAgent').mockImplementation(async (options) => {
    agentResult = await runAgent(options);
    return agentResult;
  });
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => void err.push(a.join(' ')));
  try {
    const exitCode = await runCli([
      'agent',
      'run',
      input.prompt,
      '--project',
      file,
      '--provider',
      'openrouter',
      '--api-key-env',
      'JOY_SCRIPTED_TEST_KEY',
      '--apply',
      ...(input.extraArgs ?? []),
    ]);
    const text = readFileSync(file, 'utf8');
    return {
      exitCode,
      saved: (JSON.parse(text) as { project: JoyProjectV1 }).project,
      changed: text !== original,
      stdout: out.join('\n'),
      stderr: err.join('\n'),
      agentResult,
    };
  } finally {
    modelSpy.mockRestore();
    runSpy.mockRestore();
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
}

export function rootClips(project: JoyProjectV1) {
  return project.compositions[project.rootCompositionId]!.tracks.flatMap((track) => track.clips);
}
