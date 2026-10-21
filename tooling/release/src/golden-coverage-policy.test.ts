import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Chromium pixel goldens are excluded from the default run, so they must stay in the P0 config.
// Both P0 lanes run that config and fail closed without Chromium, so the goldens cannot skip
// silently there.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const GOLDEN_FILE = 'tooling/golden-render/src/first-party-scenes.test.ts';

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function jobBlock(workflow: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.match(/\n {2}[a-z0-9-]+:\n/);
  return workflow.slice(start, nextJob ? start + marker.length + nextJob.index! : workflow.length);
}

describe('Chromium pixel golden coverage', () => {
  it('excludes the golden file from the default run and includes it in the P0 config', () => {
    expect(readRepoFile('vitest.config.ts')).toContain(`'${GOLDEN_FILE}'`);
    expect(readRepoFile('vitest.p0.config.ts')).toContain(`'${GOLDEN_FILE}'`);
  });

  it('runs the P0 config in both P0 lanes', () => {
    const workflow = readRepoFile('.github/workflows/release-candidate-v2.yml');
    expect(jobBlock(workflow, 'linux-real-services')).toContain('vitest.p0.config.ts');
    expect(jobBlock(workflow, 'windows-p0-real-services')).toContain('vitest.p0.config.ts');
  });
});
