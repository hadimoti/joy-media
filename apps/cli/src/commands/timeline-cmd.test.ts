import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { resolveTextFont } from '../render/text-font.js';

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

describe('timeline add-text layout bounds', () => {
  it.skipIf(!resolveTextFont())(
    'warns on clipped layout and rejects it under --strict',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'joy-timeline-text-bounds-'));
      const output = console.log;
      const errorOutput = console.error;
      try {
        const project = createDefaultProject('Text bounds', { id: 'text-bounds' });
        const path = join(directory, 'project.json');
        writeFileSync(path, JSON.stringify({ format: 'joy-media-project', revision: 1, project }));
        const logs: string[] = [];
        console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
        console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));
        expect(
          await runCli([
            'timeline',
            'add-text',
            '--project',
            path,
            '--text',
            'Bottom edge',
            '--duration',
            '2',
            '--y',
            '0.4',
          ]),
        ).toBe(0);
        expect(logs.join('\n')).toContain('Text may be clipped');
        const revisionAfterWarning = JSON.parse(readFileSync(path, 'utf8')).revision;
        logs.length = 0;
        expect(
          await runCli([
            'timeline',
            'add-text',
            '--project',
            path,
            '--text',
            'Bottom edge',
            '--duration',
            '2',
            '--y',
            '0.4',
            '--strict',
          ]),
        ).toBe(1);
        expect(logs.join('\n')).toContain('Text would be clipped');
        expect(JSON.parse(readFileSync(path, 'utf8')).revision).toBe(revisionAfterWarning);
      } finally {
        console.log = output;
        console.error = errorOutput;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
