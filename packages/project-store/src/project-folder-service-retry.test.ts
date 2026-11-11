import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Gate from './gate.js';
import { ProjectClaimBusyError } from './gate.js';
import { openProjectClaimRegistry } from './project-claim-registry.js';
import { createProjectFolderService, type ProjectFolderService } from './project-folder-service.js';

/**
 * The service records a new folder through recordNewProjectFolder, which it imports from gate.js. These tests make the
 * first attempts fail with the errors queued here, so the retry rule can be seen without a real lock. When the queue is
 * empty, the real record runs.
 */
const attempts = vi.hoisted(() => ({
  queued: [] as unknown[],
  made: 0,
}));

vi.mock('./gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Gate>();
  return {
    ...actual,
    recordNewProjectFolder: (...args: Parameters<typeof actual.recordNewProjectFolder>) => {
      attempts.made += 1;
      const failure = attempts.queued.shift();
      if (failure !== undefined) throw failure;
      return actual.recordNewProjectFolder(...args);
    },
  };
});

let base: string;
let directory: string;
let service: ProjectFolderService | undefined;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'joy-pf-retry-'));
  directory = join(base, 'JOY Projects');
  attempts.queued.length = 0;
  attempts.made = 0;
});

afterEach(async () => {
  service?.close();
  service = undefined;
  attempts.queued.length = 0;
  await rm(base, { recursive: true, force: true });
});

function serviceOn(): ProjectFolderService {
  service = createProjectFolderService({
    registry: openProjectClaimRegistry(join(base, 'claims.sqlite')),
    directory,
    newKey: (() => {
      let next = 0;
      return () => `key-${++next}`;
    })(),
  });
  return service;
}

describe('recording a new folder after a busy lock', () => {
  it('retries a busy lock that came before any record was saved, then makes the folder', async () => {
    attempts.queued.push(new ProjectClaimBusyError(false));
    const reply = await serviceOn().create('Summer');
    expect(reply).toMatchObject({ kind: 'created', name: 'Summer.joyproj' });
    expect(attempts.made).toBe(2);
  });

  it('does not retry a busy lock after a record was saved, and says the record is in place', async () => {
    attempts.queued.push(
      new ProjectClaimBusyError(true),
      new ProjectClaimBusyError(false),
      new ProjectClaimBusyError(false),
    );
    const reply = await serviceOn().create('Summer');
    expect(reply).toEqual({
      kind: 'refused',
      code: 'busy',
      appliedInRegistry: true,
      name: 'Summer.joyproj',
    });
    expect(attempts.made).toBe(1);
  });

  it('stops at the attempt that saved the record, after an earlier attempt that saved nothing', async () => {
    attempts.queued.push(new ProjectClaimBusyError(false), new ProjectClaimBusyError(true));
    const reply = await serviceOn().create('Summer');
    expect(reply).toEqual({
      kind: 'refused',
      code: 'busy',
      appliedInRegistry: true,
      name: 'Summer.joyproj',
    });
    expect(attempts.made).toBe(2);
  });

  it('gives up after the last attempt when no attempt saved a record, and says nothing was saved', async () => {
    attempts.queued.push(
      new ProjectClaimBusyError(false),
      new ProjectClaimBusyError(false),
      new ProjectClaimBusyError(false),
    );
    const reply = await serviceOn().create('Summer');
    expect(reply).toEqual({ kind: 'refused', code: 'busy', name: 'Summer.joyproj' });
    expect(attempts.made).toBe(3);
  });
});
