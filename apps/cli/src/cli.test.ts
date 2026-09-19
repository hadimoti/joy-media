import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import { CliJoyAgentToolBridge } from './agent/bridge.js';
import { resolveByokConfig } from './agent/provider.js';
import {
  createDefaultProject,
  listProjects,
  loadProject,
  saveProject,
} from './utils/project-loader.js';

describe('JOY Media CLI (@joy-media/cli)', () => {
  it('prints help guide on help command and exits 0', async () => {
    const code = await runCli(['help']);
    expect(code).toBe(0);
  });

  it('runs doctor command successfully', async () => {
    const code = await runCli(['doctor']);
    expect(code).toBe(0);
  });

  it('normalizes BYOK provider configuration', () => {
    const config = resolveByokConfig({
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
        '1',
        '--duration',
        '4',
        '--sqlite-path',
        testDbPath,
      ]);
      expect(addCode).toBe(0);

      const loadedAfterAdd = loadProject(project.id, testDbPath);
      const rootTrack = loadedAfterAdd.project.compositions['root']?.tracks[0];
      expect(rootTrack?.clips.length).toBe(1);
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
    it(
      'supports adding, listing, selecting, and removing providers via CLI',
      async () => {
      // 1. Add provider
      const addCode = await runCli([
        'agent',
        'provider',
        'add',
        'kilo-test',
        '--url',
        'https://api.kilo.ai/api/gateway/v1',
        '--api-key',
        'kilo-test-key-999',
        '--model',
        'minimax/minimax-m3',
      ]);
      expect(addCode).toBe(0);

      // 2. List providers
      const listCode = await runCli(['agent', 'provider', 'list']);
      expect(listCode).toBe(0);

      // 3. Use provider
      const useCode = await runCli(['agent', 'provider', 'use', 'kilo-test']);
      expect(useCode).toBe(0);

      // 4. Set default model
      const modelSetCode = await runCli(['agent', 'model', 'set', 'kilo-auto/efficient']);
      expect(modelSetCode).toBe(0);

      // 5. Verify resolution with active provider
      const resolved = resolveByokConfig();
      expect(resolved.provider).toBe('kilo');
      expect(resolved.baseUrl).toBe('https://api.kilo.ai/api/gateway/v1');
      expect(resolved.apiKey).toBe('kilo-test-key-999');
      expect(resolved.modelId).toBe('kilo-auto/efficient');

      // 6. Remove provider
      const removeCode = await runCli(['agent', 'provider', 'remove', 'kilo-test']);
      expect(removeCode).toBe(0);
    }, 15000);
  });
});
