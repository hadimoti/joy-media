import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { CliJoyAgentToolBridge } from './agent/bridge.js';
import { resolveByokConfig } from './agent/provider.js';
import { formatAgentRunFailure } from './commands/agent-cmd.js';
import { protectSecret } from './utils/secret-store.js';
import { setAiProvider } from './utils/config.js';
import { resolveTextFont } from './render/text-font.js';
import * as joyAgentRuntime from './agent/joy-agent.js';
import { JoyAgentRunError } from '@joy-media/joy-agent-engine';
import {
  createDefaultProject,
  listProjects,
  loadProject,
  saveProject,
} from './utils/project-loader.js';

describe('JOY Media CLI (@joy-media/cli)', () => {
  let isolatedHome: string;
  beforeEach(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), 'joy-cli-home-'));
    vi.stubEnv('USERPROFILE', isolatedHome);
    vi.stubEnv('HOME', isolatedHome);
    for (const key of [
      'KILO_API_KEY',
      'OPENROUTER_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'JOY_MEDIA_SESSION_TOKEN',
    ]) {
      vi.stubEnv(key, '');
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  it('prints safe provider detail only when agent debug is enabled', () => {
    const error = new JoyAgentRunError('JOY_AGENT_RATE_LIMITED', {
      detail: {
        name: 'APICallError',
        statusCode: 429,
        urlOrigin: 'https://provider.invalid',
        message: 'rate limited',
        responseBodySnippet: '',
      },
    });
    expect(formatAgentRunFailure(error, false)).toBe(
      'Joy Agent execution failed: JOY_AGENT_RATE_LIMITED',
    );
    expect(formatAgentRunFailure(error, true)).toContain('"statusCode":429');
  });

  it('maps the JOY hosted subscription gateway response to its actionable code', () => {
    const error = new JoyAgentRunError('JOY_AGENT_UNKNOWN', {
      detail: {
        name: 'APICallError',
        statusCode: 402,
        urlOrigin: 'https://joyst.ir',
        message: 'Subscription required',
        responseBodySnippet: '{"error":{"code":"JOY_SUBSCRIPTION_REQUIRED"}}',
      },
    });
    expect(formatAgentRunFailure(error, false)).toContain('JOY_SUBSCRIPTION_REQUIRED');
  });

  it('prints help guide on help command and exits 0', async () => {
    const code = await runCli(['help']);
    expect(code).toBe(0);
  });

  it('prints command-specific agent help', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runCli(['agent', '--help'])).toBe(0);
      expect(output.mock.calls.flat().join('\n')).toContain('probe');
      expect(output.mock.calls.flat().join('\n')).toContain('--apply');
      expect(output.mock.calls.flat().join('\n')).toContain('--allow-frames');
      expect(output.mock.calls.flat().join('\n')).toContain('--vision');
    } finally {
      output.mockRestore();
    }
  });

  it('returns failure for an incompatible probe without claiming success', async () => {
    const probeSpy = vi.spyOn(joyAgentRuntime, 'probeAgent').mockResolvedValue({
      capability: 'incompatible',
      provider: 'openrouter',
      modelId: 'openrouter/free',
      failure: {
        code: 'JOY_AGENT_UNKNOWN',
        retryable: false,
        detail: { name: 'Error', message: 'incompatible', responseBodySnippet: '' },
      },
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runCli(['agent', 'probe'])).toBe(1);
      expect(stdout.mock.calls.flat().join('\n')).not.toContain('Probe Successful!');
      expect(stderr.mock.calls.flat().join('\n')).toContain('Probe failed: model is incompatible');
    } finally {
      probeSpy.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it.each([
    [401, 'authentication denied'],
    [403, 'access forbidden'],
    [404, 'model missing'],
    [429, 'too many requests'],
    [503, 'provider is unavailable'],
  ])(
    'prints HTTP %i and the provider message for probe failures without debug',
    async (status, message) => {
      const probeSpy = vi.spyOn(joyAgentRuntime, 'probeAgent').mockResolvedValue({
        capability: 'untested',
        provider: 'openrouter',
        modelId: 'provider-model',
        failure: {
          code: 'JOY_AGENT_UNKNOWN',
          retryable: false,
          detail: { name: 'APICallError', statusCode: status, message, responseBodySnippet: '' },
        },
      });
      const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(await runCli(['agent', 'probe'])).toBe(1);
        expect(output.mock.calls.flat().join('\n')).toContain(`HTTP ${status}`);
        expect(output.mock.calls.flat().join('\n')).toContain(message);
      } finally {
        probeSpy.mockRestore();
        output.mockRestore();
      }
    },
  );

  it('treats a plan-only probe as a warning and exits successfully', async () => {
    const probeSpy = vi.spyOn(joyAgentRuntime, 'probeAgent').mockResolvedValue({
      capability: 'plan-only',
      provider: 'openrouter',
      modelId: 'openrouter/free',
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runCli(['agent', 'probe'])).toBe(0);
      expect(output.mock.calls.flat().join('\n')).toContain(
        'Probe OK: plan-only (no tool calling)',
      );
      expect(output.mock.calls.flat().join('\n')).not.toContain('Probe Successful!');
    } finally {
      probeSpy.mockRestore();
      output.mockRestore();
    }
  });

  it('provider list never prints any part of a saved API key', async () => {
    const key = 'sk-test-REDACTED-0000';
    setAiProvider('safe-provider', {
      name: 'safe-provider',
      provider: 'custom',
      apiKeyProtected: protectSecret(key),
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runCli(['agent', 'provider', 'list'])).toBe(0);
      const text = output.mock.calls.flat().join('\n');
      expect(text).toContain(
        process.platform === 'win32' ? 'stored (DPAPI)' : 'stored (file-0600)',
      );
      for (let i = 0; i <= key.length - 4; i++) expect(text).not.toContain(key.slice(i, i + 4));
    } finally {
      output.mockRestore();
    }
  });

  it('agent --apply saves file projects and bumps their revision', async () => {
    const project = createDefaultProject('File project', { id: 'agent-file-test' });
    const projectFile = join(isolatedHome, 'agent-file.json');
    writeFileSync(
      projectFile,
      JSON.stringify({ format: 'joy-media-project', revision: 7, project }),
      'utf8',
    );
    const updatedProject = { ...project, title: 'Updated by agent' };
    const runSpy = vi.spyOn(joyAgentRuntime, 'runJoyAgent').mockResolvedValue({
      resultText: 'done',
      capability: 'tool-loop',
      steps: 1,
      staged: { timelineOps: [], documentOps: [] },
      applied: true,
      updatedProject,
      appliedCount: 1,
      errors: [],
      placementSummary: {
        clips: [
          {
            clipId: 'agent-clip-1',
            trackId: 'track-v1',
            track: 'Video 1',
            startUs: 1_000_000,
            endUs: 2_000_000,
            sourceInUs: 3_000_000,
            sourceOutUs: 4_000_000,
          },
          {
            clipId: 'caption-1',
            trackId: 'captions',
            track: 'Captions',
            startUs: 0,
            endUs: 500_000,
          },
        ],
        gaps: [{ trackId: 'track-v1', startUs: 0, endUs: 1_000_000 }],
        blackRegions: [{ startUs: 0, endUs: 1_000_000 }],
      },
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(
        await runCli(['agent', 'run', 'change title', '--project', projectFile, '--apply']),
      ).toBe(0);
      expect(runSpy.mock.calls[0]?.[0].allowFrames).toBe(false);
      const saved = JSON.parse(readFileSync(projectFile, 'utf8')) as {
        revision: number;
        project: { title: string };
      };
      expect(saved.revision).toBe(8);
      expect(saved.project.title).toBe('Updated by agent');
      const outputText = output.mock.calls.flat().join('\n');
      expect(outputText).toContain('Applied 1 operation(s) (--apply)');
      expect(outputText).toContain('Verified timeline placement');
      expect(outputText).toContain('agent-clip-1');
      expect(outputText).toContain('Black region');
      expect(outputText).toContain('Black region (text over black)');
    } finally {
      runSpy.mockRestore();
      output.mockRestore();
    }
  });

  it('refuses invalid --apply results without saving the project', async () => {
    const project = createDefaultProject('Invalid apply project', { id: 'invalid-apply-test' });
    const projectFile = join(isolatedHome, 'invalid-apply.json');
    writeFileSync(
      projectFile,
      JSON.stringify({ format: 'joy-media-project', revision: 4, project }),
      'utf8',
    );
    const runSpy = vi.spyOn(joyAgentRuntime, 'runJoyAgent').mockResolvedValue({
      resultText: 'refused',
      capability: 'tool-loop',
      steps: 1,
      staged: { timelineOps: [], documentOps: [] },
      applied: false,
      updatedProject: project,
      appliedCount: 0,
      errors: ['visualObjects.title.transform.opacity is invalid'],
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await runCli(['agent', 'run', 'set invalid opacity', '--project', projectFile, '--apply']),
      ).toBe(1);
      const saved = JSON.parse(readFileSync(projectFile, 'utf8')) as { revision: number };
      expect(saved.revision).toBe(4);
      expect(stderr.mock.calls.flat().join('\n')).toContain('Apply refused');
    } finally {
      runSpy.mockRestore();
      stderr.mockRestore();
    }
  });

  it('passes explicit frame consent to the agent run', async () => {
    const project = createDefaultProject('Frame consent project', { id: 'frame-consent-test' });
    const projectFile = join(isolatedHome, 'frame-consent.json');
    writeFileSync(
      projectFile,
      JSON.stringify({ format: 'joy-media-project', revision: 1, project }),
    );
    const runSpy = vi.spyOn(joyAgentRuntime, 'runJoyAgent').mockResolvedValue({
      resultText: 'done',
      capability: 'tool-loop',
      steps: 1,
      staged: { timelineOps: [], documentOps: [] },
      applied: false,
      updatedProject: project,
      appliedCount: 0,
      errors: [],
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(
        await runCli([
          'agent',
          'run',
          'inspect',
          '--project',
          projectFile,
          '--allow-frames',
          '--vision',
        ]),
      ).toBe(0);
      expect(runSpy.mock.calls[0]?.[0].allowFrames).toBe(true);
      expect(runSpy.mock.calls[0]?.[0].vision).toBe(true);
    } finally {
      runSpy.mockRestore();
      output.mockRestore();
    }
  });

  it('runs doctor command successfully', async () => {
    const code = await runCli(['doctor']);
    expect(code).toBe(0);
  });

  it('normalizes BYOK provider configuration', async () => {
    const config = await resolveByokConfig({
      provider: 'openrouter',
      model: 'anthropic/claude-3.7-sonnet',
      apiKey: 'test-key',
    });
    expect(config.provider).toBe('openrouter');
    expect(config.modelId).toBe('anthropic/claude-3.7-sonnet');
    expect(config.apiKey).toBe('test-key');
  });

  describe('Project Management & Persistence', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'joy-cli-test-'));
    const testDbPath = join(tempDir, 'test-joy.sqlite3');

    it('creates, saves, lists, and loads projects in SQLite', () => {
      const project = createDefaultProject('Automated Test Project');
      expect(project.title).toBe('Automated Test Project');
      expect(project.schemaVersion).toBe(1);

      const rev1 = saveProject(project, {
        source: 'sqlite',
        path: testDbPath,
        revision: 0,
      });
      expect(rev1).toBe(1);

      const list = listProjects(testDbPath);
      expect(list.length).toBe(1);
      expect(list[0]?.id).toBe(project.id);
      expect(list[0]?.title).toBe('Automated Test Project');

      const loaded = loadProject(project.id, testDbPath);
      expect(loaded.project.id).toBe(project.id);
      expect(loaded.revision).toBe(1);
    });

    it('executes project CLI subcommands (list, show, export, import)', async () => {
      const exportFile = join(tempDir, 'exported-project.json');

      const listCode = await runCli(['project', 'list', '--sqlite-path', testDbPath]);
      expect(listCode).toBe(0);

      const projects = listProjects(testDbPath);
      const targetId = projects[0]!.id;

      const showCode = await runCli(['project', 'show', targetId, '--sqlite-path', testDbPath]);
      expect(showCode).toBe(0);

      const exportCode = await runCli([
        'project',
        'export',
        targetId,
        '--output',
        exportFile,
        '--sqlite-path',
        testDbPath,
      ]);
      expect(exportCode).toBe(0);
      expect(existsSync(exportFile)).toBe(true);

      const importCode = await runCli([
        'project',
        'import',
        exportFile,
        '--sqlite-path',
        testDbPath,
      ]);
      expect(importCode).toBe(0);
    });

    it('cleans up temporary database', () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Safe on Windows transient locks
      }
    });
  });

  describe('Timeline Direct Manipulation Commands', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'joy-cli-timeline-'));
    const testDbPath = join(tempDir, 'timeline-test.sqlite3');
    const project = createDefaultProject('Timeline Ops Project');
    saveProject(project, { source: 'sqlite', path: testDbPath, revision: 0 });

    it('adds, splits, trims, and removes clips via CLI', async () => {
      // 1. Add clip
      const addCode = await runCli([
        'timeline',
        'add-clip',
        '--project',
        project.id,
        '--track',
        'track-v1',
        '--start',
        '0',
        '--duration',
        '4',
        '--sqlite-path',
        testDbPath,
      ]);
      expect(addCode).toBe(0);

      const loadedAfterAdd = loadProject(project.id, testDbPath);
      const rootTrack = loadedAfterAdd.project.compositions['root']?.tracks[0];
      expect(rootTrack?.clips.length).toBe(1);
      expect(loadedAfterAdd.project.compositions.root?.durationUs).toBe(4_000_000);
      const clipId = rootTrack!.clips[0]!.id;

      // 2. Split clip at 3 seconds
      const splitCode = await runCli([
        'timeline',
        'split',
        '--project',
        project.id,
        '--clip',
        clipId,
        '--at',
        '3',
        '--sqlite-path',
        testDbPath,
      ]);
      expect(splitCode).toBe(0);

      const loadedAfterSplit = loadProject(project.id, testDbPath);
      const trackAfterSplit = loadedAfterSplit.project.compositions['root']?.tracks[0];
      expect(trackAfterSplit?.clips.length).toBe(2);

      // 3. Trim second part
      const splitClip2 = trackAfterSplit!.clips[1]!.id;
      const trimCode = await runCli([
        'timeline',
        'trim',
        '--project',
        project.id,
        '--clip',
        splitClip2,
        '--start',
        '3.5',
        '--duration',
        '1',
        '--sqlite-path',
        testDbPath,
      ]);
      expect(trimCode).toBe(0);

      // 4. Remove first part
      const removeCode = await runCli([
        'timeline',
        'remove-clip',
        '--project',
        project.id,
        '--clip',
        clipId,
        '--sqlite-path',
        testDbPath,
      ]);
      expect(removeCode).toBe(0);

      const loadedFinal = loadProject(project.id, testDbPath);
      const finalClips = loadedFinal.project.compositions['root']?.tracks[0]?.clips;
      expect(finalClips?.length).toBe(1);
    });

    it.skipIf(!resolveTextFont())('adds a schema-valid, timed text clip via CLI', async () => {
      const textProject = createDefaultProject('Text CLI Project', { id: 'text-cli-project' });
      saveProject(textProject, { source: 'sqlite', path: testDbPath, revision: 0 });
      expect(
        await runCli([
          'timeline',
          'add-text',
          '--project',
          textProject.id,
          '--text',
          'CLI title',
          '--start',
          '1',
          '--duration',
          '2',
          '--size',
          '52',
          '--color',
          '#ffcc00',
          '--sqlite-path',
          testDbPath,
        ]),
      ).toBe(0);
      const saved = loadProject(textProject.id, testDbPath).project;
      const captionTrack = saved.compositions.root!.tracks.find(
        (track) => track.kind === 'caption',
      );
      const captionClip = captionTrack?.clips[0];
      expect(captionClip).toBeDefined();
      if (!captionClip || captionClip.kind !== 'caption') throw new Error('caption clip missing');
      expect(captionClip).toMatchObject({ startUs: 1_000_000, durationUs: 2_000_000 });
      expect(
        saved.captionDocuments[captionClip.captionDocumentId]?.words[
          `${captionClip.captionDocumentId}-word`
        ]?.text,
      ).toBe('CLI title');
    });

    it('fits root duration to content with a one-second minimum', async () => {
      const project = createDefaultProject('Fit extent project', { id: 'fit-extent-test' });
      (
        project.compositions.root!.tracks[0]!.clips as unknown as Array<Record<string, unknown>>
      ).push({
        id: 'base-clip',
        kind: 'video',
        assetId: 'asset-default',
        startUs: 0,
        durationUs: 10_000_000,
        sourceInUs: 0,
      });
      saveProject(project, { source: 'sqlite', path: testDbPath, revision: 0 });
      expect(
        await runCli([
          'timeline',
          'add-clip',
          '--project',
          project.id,
          '--track',
          'track-v1',
          '--start',
          '10',
          '--duration',
          '5',
          '--sqlite-path',
          testDbPath,
        ]),
      ).toBe(0);
      const extended = loadProject(project.id, testDbPath);
      expect(extended.project.compositions.root?.durationUs).toBe(15_000_000);
      const addedClip = extended.project.compositions.root!.tracks[0]!.clips.find(
        (clip) => clip.id !== 'base-clip',
      )!;
      expect(
        await runCli([
          'timeline',
          'remove-clip',
          '--project',
          project.id,
          '--clip',
          addedClip.id,
          '--sqlite-path',
          testDbPath,
        ]),
      ).toBe(0);
      expect(loadProject(project.id, testDbPath).project.compositions.root?.durationUs).toBe(
        10_000_000,
      );
    });

    it('validates an asset id and defaults the new clip duration from asset metadata', async () => {
      const project = createDefaultProject('asset-backed timeline', {
        id: 'asset-backed-timeline',
      });
      (project.assets as Record<string, unknown>)['clip-asset'] = {
        id: 'clip-asset',
        kind: 'video',
        displayName: 'clip.mp4',
        descriptor: { mimeType: 'video/mp4', durationUs: 2_500_000 },
        localSource: { path: 'C:\\media\\clip.mp4' },
      };
      saveProject(project, { source: 'sqlite', path: testDbPath, revision: 0 });
      expect(
        await runCli([
          'timeline',
          'add-clip',
          '--project',
          project.id,
          '--asset',
          'missing',
          '--sqlite-path',
          testDbPath,
        ]),
      ).toBe(1);
      expect(
        await runCli([
          'timeline',
          'add-clip',
          '--project',
          project.id,
          '--asset',
          'clip-asset',
          '--sqlite-path',
          testDbPath,
        ]),
      ).toBe(0);
      const loaded = loadProject(project.id, testDbPath);
      expect(loaded.project.compositions.root!.tracks[0]!.clips[0]!.durationUs).toBe(2_500_000);
    });

    it('cleans up timeline test database', () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Safe on Windows transient locks
      }
    });
  });

  describe('Full-Power Joy Agent Tool Bridge', () => {
    it('provides project summary and timeline window inspection', async () => {
      const project = createDefaultProject('Agent Bridge Test Project');
      const bridge = new CliJoyAgentToolBridge(project, 1);

      const summary = (await bridge.readProjectSummary()) as {
        projectId: string;
        clipCount: number;
        tracks: Array<{ id: string }>;
      };
      expect(summary.projectId).toBe(project.id);
      expect(summary.tracks.length).toBe(3);

      const window = (await bridge.readTimelineWindow({ startUs: 0, endUs: 5_000_000 })) as {
        clips: unknown[];
      };
      expect(Array.isArray(window.clips)).toBe(true);
    });

    it('stages and applies proposed timeline operations with rollback safety', async () => {
      const project = createDefaultProject('Staged Mutation Test');
      const bridge = new CliJoyAgentToolBridge(project, 1);

      // Propose insert operation
      await bridge.proposeTimelineOperations({
        operations: [
          {
            kind: 'insert',
            id: 'agent-clip-1',
            assetId: 'asset-video-1',
            trackId: 'track-v1',
            startUs: 0,
            durationUs: 3_000_000,
            dependsOn: [],
          },
        ],
      });

      const staged = bridge.getStagedOperations();
      expect(staged.timelineOps.length).toBe(1);

      // Apply staged
      const applyResult = bridge.applyStaged();
      expect(applyResult.appliedCount).toBe(1);
      expect(applyResult.errors.length).toBe(0);

      const v1Clips = applyResult.updatedProject.compositions['root']?.tracks[0]?.clips;
      expect(v1Clips?.length).toBe(1);
      expect(v1Clips?.[0]?.id).toBe('agent-clip-1');
    });
  });

  describe('Multi-API Provider & Model Configuration Commands', () => {
    it('prints the effective default provider and model', async () => {
      const providerHome = mkdtempSync(join(tmpdir(), 'joy-cli-config-test-'));
      vi.stubEnv('USERPROFILE', providerHome);
      vi.stubEnv('HOME', providerHome);
      for (const key of [
        'KILO_API_KEY',
        'OPENROUTER_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'JOY_MEDIA_SESSION_TOKEN',
      ]) {
        vi.stubEnv(key, '');
      }
      const output: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
        output.push(args.join(' '));
      });
      try {
        expect(await runCli(['agent', 'config'])).toBe(0);
        expect(output.join('\n')).toContain('openrouter/free');
        expect(output.join('\n')).not.toContain('claude-3.7-sonnet');
        expect(output.join('\n')).toContain('source: default');
        output.length = 0;
        expect(await runCli(['agent', 'model', 'get'])).toBe(0);
        expect(output.join('\n')).toContain('openrouter/free');
        expect(output.join('\n')).toContain('source: default');
      } finally {
        log.mockRestore();
        vi.stubEnv('USERPROFILE', isolatedHome);
        vi.stubEnv('HOME', isolatedHome);
        for (const key of [
          'KILO_API_KEY',
          'OPENROUTER_API_KEY',
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
          'JOY_MEDIA_SESSION_TOKEN',
        ]) {
          vi.stubEnv(key, '');
        }
        rmSync(providerHome, { recursive: true, force: true });
      }
    });

    it('supports adding, listing, selecting, and removing providers via CLI', async () => {
      const providerHome = mkdtempSync(join(tmpdir(), 'joy-cli-provider-test-'));
      vi.stubEnv('USERPROFILE', providerHome);
      vi.stubEnv('HOME', providerHome);
      for (const key of [
        'KILO_API_KEY',
        'OPENROUTER_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'JOY_MEDIA_SESSION_TOKEN',
      ]) {
        vi.stubEnv(key, '');
      }
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              data: [
                { id: 'byteplus-coding/dola-seed-2.0-pro' },
                { id: 'byteplus-coding/dola-seed-2.0-lite' },
                { id: 'byteplus-coding/deepseek-v4-flash' },
              ],
            }),
            { status: 200 },
          ),
        ),
      );
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        // 1. Add provider; discovery is served by the local mock.
        const addCode = await runCli([
          'agent',
          'provider',
          'add',
          'kilo-test',
          '--url',
          'https://api.kilo.ai/api/gateway/v1',
          '--api-key',
          'sk-test-REDACTED-0000',
          '--model',
          'byteplus-coding/dola-seed-2.0-pro',
        ]);
        expect(addCode).toBe(0);
        const addOutput = output.mock.calls.flat().join('\n');
        if (process.platform === 'win32') {
          expect(addOutput).not.toContain('mode 0600');
        } else {
          expect(addOutput).toContain('stored in a mode 0600 file');
          expect(addOutput).toContain('--api-key-env <VAR>');
        }

        // 2. List providers
        const listCode = await runCli(['agent', 'provider', 'list']);
        expect(listCode).toBe(0);

        // 3. Use provider
        const useCode = await runCli(['agent', 'provider', 'use', 'kilo-test']);
        expect(useCode).toBe(0);

        // 4. Set default model
        const modelSetCode = await runCli([
          'agent',
          'model',
          'set',
          'byteplus-coding/dola-seed-2.0-lite',
        ]);
        expect(modelSetCode).toBe(0);

        // 5. Verify resolution with active provider
        const resolved = await resolveByokConfig();
        expect(resolved.provider).toBe('kilo');
        expect(resolved.baseUrl).toBe('https://api.kilo.ai/api/gateway');
        expect(resolved.apiKey).toBe('sk-test-REDACTED-0000');
        expect(resolved.modelId).toBe('byteplus-coding/dola-seed-2.0-lite');

        // 6. Remove provider
        const removeCode = await runCli(['agent', 'provider', 'remove', 'kilo-test']);
        expect(removeCode).toBe(0);
      } finally {
        output.mockRestore();
        vi.unstubAllGlobals();
        vi.stubEnv('USERPROFILE', isolatedHome);
        vi.stubEnv('HOME', isolatedHome);
        for (const key of [
          'KILO_API_KEY',
          'OPENROUTER_API_KEY',
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
          'JOY_MEDIA_SESSION_TOKEN',
        ]) {
          vi.stubEnv(key, '');
        }
        rmSync(providerHome, { recursive: true, force: true });
      }
    }, 15000);
  });
});
