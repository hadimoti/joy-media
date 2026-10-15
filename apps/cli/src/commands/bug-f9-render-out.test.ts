// F9: `render --out x.mp4` silently created a directory named x.mp4/ and wrote
// x.mp4/<project-id>.mp4 inside it.
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { fixtureProject } from '../agent/scripted-agent.test-helper.js';

async function render(out: string, extra: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'joy-render-out-'));
  const file = join(home, 'project.json');
  writeFileSync(
    file,
    JSON.stringify({ format: 'joy-media-project', revision: 1, project: fixtureProject({}) }),
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const target = join(home, out);
    const exitCode = await runCli([
      'render',
      '--project',
      file,
      '--out',
      target,
      '--manifest-only',
      ...extra,
    ]);
    return { exitCode, target, home };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('F9: render --out with a file name', () => {
  it('writes next to the named file instead of creating a directory called final.mp4', async () => {
    const { target, home } = await render('final.mp4');
    try {
      expect(existsSync(target) && statSync(target).isDirectory()).toBe(false);
      expect(existsSync(`${target}.manifest.json`)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a file extension that does not match the preset', async () => {
    const { exitCode, home } = await render('final.webm', ['--preset', 'mp4']);
    rmSync(home, { recursive: true, force: true });
    expect(exitCode).toBe(2);
  });

  it('a plain directory still works as before', async () => {
    const { target, home } = await render('renders');
    try {
      expect(statSync(target).isDirectory()).toBe(true);
      expect(existsSync(join(target, 'scripted-repro.mp4.manifest.json'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
