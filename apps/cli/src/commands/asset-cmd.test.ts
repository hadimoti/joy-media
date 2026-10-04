import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from '../cli.js';
import { createDefaultProject } from '../utils/project-loader.js';

const hasFfprobe = spawnSync('ffprobe', ['-version'], { shell: false }).status === 0;

describe('asset import and list', () => {
  it.skipIf(!hasFfprobe)('imports local media metadata and lists the asset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-asset-import-'));
    try {
      const projectPath = join(dir, 'project.json');
      const project = createDefaultProject('asset import test');
      await import('node:fs').then(({ writeFileSync }) =>
        writeFileSync(projectPath, JSON.stringify(project)),
      );
      const media = resolve('packages/test-fixtures/media/video.mp4');
      expect(
        await runCli(['asset', 'import', media, '--project', projectPath, '--id', 'local-video']),
      ).toBe(0);
      const saved = JSON.parse(readFileSync(projectPath, 'utf8')).project;
      expect(saved.assets['local-video']).toMatchObject({
        kind: 'video',
        localSource: { path: media },
        descriptor: { width: 320, height: 180 },
      });
      expect(saved.assets['local-video'].descriptor.durationUs).toBeGreaterThan(0);
      expect(saved.assets['local-video'].sha256).toMatch(/^[a-f0-9]{64}$/);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await runCli(['asset', 'list', '--project', projectPath])).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('local-video'));
      log.mockRestore();
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
