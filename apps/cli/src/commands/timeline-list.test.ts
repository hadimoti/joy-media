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

  it('prints timeline help without requiring a project', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCli(['timeline', 'help'])).toBe(0);
    expect(await runCli(['timeline', 'add-text', '--help'])).toBe(0);
    const help = output.mock.calls.flat().join('\n');
    expect(help).toContain(
      'x is horizontal frame offset (0 = center, -0.4 = near left, 0.4 = near right)',
    );
    expect(help).toContain(
      'y offsets the template bottom title line (0 = default position, negative = up, positive = down)',
    );
    expect(help).toContain('rendering clamps y to the frame');
    expect(help).toContain('add-text warns if text may clip');
    output.mockRestore();
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
});
