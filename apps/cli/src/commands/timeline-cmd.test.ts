import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';
import { resolveTextFont } from '../render/text-font.js';

describe('timeline clip looks', () => {
  it('accepts the asset id as the add-clip positional argument', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-timeline-positional-asset-'));
    try {
      const project = createDefaultProject('positional asset', { id: 'positional-asset-project' });
      (project.assets as Record<string, unknown>)['asset-a'] = {
        id: 'asset-a',
        kind: 'video',
        displayName: 'asset.mp4',
        descriptor: { durationUs: 1_500_000 },
      };
      const path = join(directory, 'project.json');
      writeFileSync(path, JSON.stringify({ format: 'joy-media-project', revision: 1, project }));
      expect(await runCli(['timeline', 'add-clip', 'asset-a', '--project', path])).toBe(0);
      const saved = JSON.parse(readFileSync(path, 'utf8')).project;
      expect(saved.compositions.root.tracks[0].clips[0]).toMatchObject({
        assetId: 'asset-a',
        durationUs: 1_500_000,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lists source and timeline ranges plus looks in human and JSON output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-timeline-list-'));
    const originalLog = console.log;
    try {
      const project = createDefaultProject('timeline list', { id: 'timeline-list-cli' });
      (project.compositions.root!.tracks[0]!.clips as unknown as Array<any>).push({
        id: 'listed-clip',
        kind: 'video',
        assetId: 'asset-default',
        startUs: 2_000_000,
        durationUs: 3_000_000,
        sourceInUs: 7_000_000,
        look: { preset: 'crt' },
      });
      const path = join(directory, 'project.json');
      writeFileSync(path, JSON.stringify({ format: 'joy-media-project', revision: 1, project }));
      const logs: string[] = [];
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
      expect(await runCli(['timeline', 'list', '--project', path, '--json'])).toBe(0);
      const json = JSON.parse(logs.join(''));
      expect(json.tracks[0].clips[0]).toMatchObject({
        timelineStartUs: 2_000_000,
        timelineEndUs: 5_000_000,
        sourceInUs: 7_000_000,
        sourceOutUs: 10_000_000,
        look: { preset: 'crt' },
      });
      logs.length = 0;
      expect(await runCli(['timeline', 'list', '--project', path])).toBe(0);
      expect(logs.join('\n')).toContain('timeline=2.000–5.000s source=7.000–10.000s look=crt');
    } finally {
      console.log = originalLog;
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it('accepts add-effect flag aliases and documents how to move a trimmed clip to zero', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-timeline-aliases-'));
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      const project = createDefaultProject('trim and move', { id: 'trim-move-project' });
      (project.assets as Record<string, unknown>)['asset-default'] = {
        id: 'asset-default',
        kind: 'video',
        displayName: 'asset.mp4',
        descriptor: { durationUs: 30_000_000, mimeType: 'video/mp4', width: 1920, height: 1080 },
      };
      const track = project.compositions.root!.tracks[0]!;
      (track.clips as unknown[]).push({
        id: 'alias-clip',
        kind: 'video',
        assetId: 'asset-default',
        startUs: 0,
        durationUs: 20_000_000,
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
          '--project',
          projectPath,
          '--clipId',
          'alias-clip',
          '--type',
          'warm',
        ]),
      ).toBe(0);
      expect(
        await runCli([
          'timeline',
          'add-effect',
          '--project',
          projectPath,
          '--clip-id',
          'alias-clip',
          '--kind',
          'crt',
        ]),
      ).toBe(0);
      expect(
        await runCli([
          'timeline',
          'trim',
          '--project',
          projectPath,
          '--clip',
          'alias-clip',
          '--start',
          '7',
          '--end',
          '17',
        ]),
      ).toBe(0);
      let saved = JSON.parse(readFileSync(projectPath, 'utf8')).project;
      expect(saved.compositions.root.tracks[0].clips[0]).toMatchObject({
        startUs: 7_000_000,
        durationUs: 10_000_000,
        sourceInUs: 7_000_000,
        look: { preset: 'crt' },
      });
      expect(
        await runCli([
          'timeline',
          'move-clip',
          '--project',
          projectPath,
          '--clip',
          'alias-clip',
          '--start',
          '0',
        ]),
      ).toBe(0);
      saved = JSON.parse(readFileSync(projectPath, 'utf8')).project;
      expect(saved.compositions.root.tracks[0].clips[0]).toMatchObject({
        startUs: 0,
        durationUs: 10_000_000,
        sourceInUs: 7_000_000,
      });
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
      await runCli(['timeline', 'help']);
      expect(logs.join('\n')).toContain('Use move-clip --start 0');
    } finally {
      console.log = originalLog;
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
