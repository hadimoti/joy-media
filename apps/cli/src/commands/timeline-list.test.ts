import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { createDefaultProject, saveProject } from '../utils/project-loader.js';

describe('timeline list', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'joy-timeline-list-'));
  const sqlitePath = join(tempDir, 'timeline.sqlite3');
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the real audio track kind for track-a1', async () => {
    const project = createDefaultProject('Timeline kinds', { id: 'timeline-kinds' });
    saveProject(project, { source: 'sqlite', path: sqlitePath, revision: 0 });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(
      await runCli(['timeline', 'list', '--project', project.id, '--sqlite-path', sqlitePath]),
    ).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('track-a1 [audio]');
    expect(output.mock.calls.flat().join('\n')).not.toContain('track-a1 [video]');
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
});
