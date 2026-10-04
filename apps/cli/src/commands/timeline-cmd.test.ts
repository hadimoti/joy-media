import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';

describe('timeline clip looks', () => {
  it('adds and clears a schema-validated look and rejects out-of-range intensity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-timeline-look-'));
    try {
      const project = createDefaultProject('clip look cli', { id: 'clip-look-cli' });
      (project.compositions.root!.tracks[0]!.clips as unknown[]).push({
        id: 'look-target',
        kind: 'video',
        assetId: 'asset-default',
        startUs: 0,
        durationUs: 1_000_000,
        sourceInUs: 0,
      });
      const projectPath = join(directory, 'project.json');
      writeFileSync(
        projectPath,
        JSON.stringify({ format: 'joy-media-project', revision: 1, project }),
      );
      expect(
        await runCli([
          'timeline',
          'add-effect',
          'look-target',
          '--project',
          projectPath,
          '--look',
          'crt',
          '--intensity',
          '0.8',
          '--scanline-strength',
          '0.6',
        ]),
      ).toBe(0);
      const loaded = JSON.parse(readFileSync(projectPath, 'utf8')).project;
      expect(loaded.compositions.root.tracks[0].clips[0]).toMatchObject({
        look: { preset: 'crt', intensity: 0.8, scanlineStrength: 0.6 },
      });
      expect(
        await runCli([
          'timeline',
          'add-effect',
          'look-target',
          '--project',
          projectPath,
          '--look',
          'crt',
          '--intensity',
          '1.1',
        ]),
      ).toBe(2);
      expect(
        await runCli(['timeline', 'clear-effect', 'look-target', '--project', projectPath]),
      ).toBe(0);
      expect(
        JSON.parse(readFileSync(projectPath, 'utf8')).project.compositions.root.tracks[0].clips[0],
      ).not.toHaveProperty('look');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
