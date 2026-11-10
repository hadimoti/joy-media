import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openProjectClaimRegistry,
  readProjectClaim,
  writeProjectClaim,
  type ProjectClaimRegistry,
} from './project-claim-registry.js';

let scratch: string;
let open: ProjectClaimRegistry[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'joy-claim-registry-'));
  open = [];
});

afterEach(async () => {
  for (const registry of open) registry.close();
  await rm(scratch, { recursive: true, force: true });
});

function track(registry: ProjectClaimRegistry): ProjectClaimRegistry {
  open.push(registry);
  return registry;
}

describe('project claim registry', () => {
  it('keeps a claim across a reopen', () => {
    const path = join(scratch, 'app-data', 'project-claims.sqlite');
    const first = openProjectClaimRegistry(path);
    const folderPath = join(scratch, 'A.joyproj');
    writeProjectClaim(first, {
      projectId: 'project-a',
      folderIdentity: '7:42',
      folderPath,
      recordedAt: '2026-11-10T00:00:00.000Z',
    });
    first.close();

    const again = track(openProjectClaimRegistry(path));

    expect(readProjectClaim(again, 'project-a')).toEqual({
      projectId: 'project-a',
      folderIdentity: '7:42',
      folderPath,
      recordedAt: '2026-11-10T00:00:00.000Z',
    });
  });

  it('replaces the record when the same id is claimed again', () => {
    const registry = track(openProjectClaimRegistry(join(scratch, 'claims.sqlite')));
    writeProjectClaim(registry, {
      projectId: 'project-a',
      folderIdentity: '7:42',
      folderPath: join(scratch, 'A.joyproj'),
      recordedAt: '2026-11-10T00:00:00.000Z',
    });
    const movedPath = join(scratch, 'B.joyproj');
    writeProjectClaim(registry, {
      projectId: 'project-a',
      folderIdentity: '7:99',
      folderPath: movedPath,
      recordedAt: '2026-11-10T01:00:00.000Z',
    });

    expect(readProjectClaim(registry, 'project-a')).toEqual({
      projectId: 'project-a',
      folderIdentity: '7:99',
      folderPath: movedPath,
      recordedAt: '2026-11-10T01:00:00.000Z',
    });
  });

  it('reads nothing for an id that was never claimed', () => {
    const registry = track(openProjectClaimRegistry(join(scratch, 'claims.sqlite')));

    expect(readProjectClaim(registry, 'project-none')).toBeUndefined();
  });
});
