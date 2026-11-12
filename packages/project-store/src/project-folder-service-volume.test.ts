import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProjectClaimRegistry } from './project-claim-registry.js';
import { createProjectFolderService, type ProjectFolderService } from './project-folder-service.js';
import { forgetVolumeAnswers } from './project-volume.js';

/**
 * Condition (q): the service asks Windows about the projects folder's volume without blocking its thread, before the
 * claim's own check, so that check finds the answer kept and never runs PowerShell inline. Windows only, because other
 * platforms have no volume rule. The real PowerShell answers; the mocks only count the calls.
 */

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync as typeof execFileSync),
    execFile: vi.fn(actual.execFile as typeof execFile),
  };
});

const askedInline = vi.mocked(execFileSync);
const askedAsync = vi.mocked(execFile);

let base: string;
const services: ProjectFolderService[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'joy-pf-volume-'));
  forgetVolumeAnswers();
  askedInline.mockClear();
  askedAsync.mockClear();
});

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await rm(base, { recursive: true, force: true });
});

function powershellCalls(mock: typeof askedInline | typeof askedAsync): number {
  return mock.mock.calls.filter((call) => call[0] === 'powershell.exe').length;
}

describe('the volume check in the service (condition (q))', () => {
  it.skipIf(process.platform !== 'win32')(
    'create, open and answer ask Windows once, without blocking, and the claims ask nothing inline',
    async () => {
      let next = 0;
      const service = createProjectFolderService({
        registry: openProjectClaimRegistry(join(base, 'claims.sqlite')),
        directory: join(base, 'JOY Projects'),
        newKey: () => `key-${++next}`,
      });
      services.push(service);

      const created = await service.create('Volume check');
      expect(created).toMatchObject({ kind: 'created' });
      if (created.kind !== 'created') throw new Error('expected a created folder');
      await expect(service.open(created.key)).resolves.toMatchObject({ kind: 'ready' });
      service.closeFolder(created.key);
      await expect(service.answer(created.key, 'original')).resolves.toMatchObject({
        kind: 'answered',
      });

      expect(powershellCalls(askedAsync)).toBe(1);
      expect(powershellCalls(askedInline)).toBe(0);
    },
  );
});
