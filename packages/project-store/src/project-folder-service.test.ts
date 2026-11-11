import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProjectClaimRegistry } from './project-claim-registry.js';
import {
  createProjectFolder,
  openProjectFolder,
  readProjectFolderEntry,
} from './project-folder.js';
import {
  createProjectFolderService,
  handleProjectFolderMessage,
  type ProjectFolderService,
} from './project-folder-service.js';

/**
 * The desktop's project-folder rules on real folders in a temporary directory. Each folder is opened and closed by the
 * service, as the worker does, so renames and copies in these tests see no open database.
 */

let base: string;
let directory: string;
const services: ProjectFolderService[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'joy-pf-service-'));
  directory = join(base, 'JOY Projects');
});

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await rm(base, { recursive: true, force: true });
});

/** A service over the default folder, with its own claim registry file (`claims.sqlite` unless named). */
function serviceOn(registryName = 'claims.sqlite'): ProjectFolderService {
  const service = createProjectFolderService({
    registry: openProjectClaimRegistry(join(base, registryName)),
    directory,
    newKey: (() => {
      let next = 0;
      return () => `key-${++next}`;
    })(),
  });
  services.push(service);
  return service;
}

/** The key the service gave a folder in its listing. Keys come only from a listing or a create. */
async function keyOf(service: ProjectFolderService, name: string): Promise<string> {
  const listed = await service.list();
  const item = listed.folders.find((folder) => folder.name === name);
  if (item === undefined) throw new Error(`no listed folder named ${name}`);
  return item.key;
}

/** The real path the registry stores for a folder, as the claim code writes it. */
function placeOf(name: string): string {
  return realpathSync.native(join(directory, name));
}

/** Makes a copy of a folder project in the same directory, as a file copy would. */
function copyFolder(from: string, to: string): void {
  cpSync(join(directory, from), join(directory, to), { recursive: true });
}

/** Writes raw SQL into a folder's own database, then closes it. Only the tests do this. */
async function editFolderDatabase(name: string, sql: string): Promise<void> {
  const folder = await openProjectFolder(join(directory, name));
  try {
    folder.database.exec(sql);
  } finally {
    folder.close();
  }
}

describe('creating and listing folder projects', () => {
  it('refuses an empty title and writes no folder', async () => {
    const service = serviceOn();
    await expect(service.create('   ')).resolves.toEqual({
      kind: 'refused',
      code: 'no-title',
    });
    const listed = await service.list().catch(() => undefined);
    expect(listed?.folders ?? []).toEqual([]);
  });

  it('creates NAME.joyproj in the default folder, with its id as the timeline and visual id', async () => {
    const service = serviceOn();
    const reply = await service.create('  Summer Cut  ');
    expect(reply).toMatchObject({
      kind: 'created',
      name: 'Summer Cut.joyproj',
      title: 'Summer Cut',
    });
    if (reply.kind !== 'created') throw new Error('expected a created folder');
    expect(reply.id).toMatch(/^project-/);

    const listed = await service.list();
    const item = listed.folders.find((folder) => folder.name === 'Summer Cut.joyproj');
    expect(item).toMatchObject({
      key: reply.key,
      entry: {
        id: reply.id,
        title: 'Summer Cut',
        timelineProjectId: reply.id,
        visualProjectId: reply.id,
      },
    });
    expect(item?.entry).not.toHaveProperty('homeRoot');
  });

  it('refuses a name that is already taken, and leaves the first folder as it was', async () => {
    const service = serviceOn();
    const first = await service.create('Summer Cut');
    const second = await service.create('Summer Cut');
    expect(second).toEqual({ kind: 'refused', code: 'name-taken', name: 'Summer Cut.joyproj' });
    const listed = await service.list();
    const named = listed.folders.filter((folder) => folder.name === 'Summer Cut.joyproj');
    expect(named).toHaveLength(1);
    expect(named[0]?.entry?.id).toBe(first.kind === 'created' ? first.id : undefined);
  });

  it('lists a folder with no entry as a problem, and never hides the others', async () => {
    const service = serviceOn();
    await service.create('Summer Cut');
    const loose = await createProjectFolder(directory, 'Loose');
    loose.close();

    const listed = await service.list();
    const loosePart = listed.folders.find((folder) => folder.name === 'Loose.joyproj');
    expect(loosePart).toMatchObject({ problem: 'no-entry' });
    expect(loosePart).not.toHaveProperty('entry');
    expect(
      listed.folders.find((folder) => folder.name === 'Summer Cut.joyproj')?.entry,
    ).toBeDefined();
  });

  it('lists a folder without a project database as not a folder', async () => {
    const service = serviceOn();
    mkdirSync(join(directory, 'Bare.joyproj'), { recursive: true });
    const listed = await service.list();
    expect(listed.folders.find((folder) => folder.name === 'Bare.joyproj')).toMatchObject({
      problem: 'not-a-folder',
    });
  });
});

describe('opening a folder project', () => {
  it('settles a new folder as kept and reports its id and title', async () => {
    const service = serviceOn();
    const created = await service.create('Summer Cut');
    if (created.kind !== 'created') throw new Error('expected a created folder');
    await expect(service.open(created.key)).resolves.toEqual({
      kind: 'ready',
      claim: 'kept',
      id: created.id,
      title: 'Summer Cut',
      siblings: [],
    });
  });

  it('refuses a key that was never listed, so the renderer cannot name its own path', async () => {
    const service = serviceOn();
    await service.create('Summer Cut');
    await expect(service.open('C:\\Windows')).resolves.toEqual({
      kind: 'refused',
      code: 'unknown-folder',
    });
  });

  it('settles a copy as renewed, names the id it had, and lists the original as a sibling', async () => {
    const service = serviceOn();
    const original = await service.create('Summer');
    if (original.kind !== 'created') throw new Error('expected a created folder');
    copyFolder('Summer.joyproj', 'Summer copy.joyproj');

    const copyKey = await keyOf(service, 'Summer copy.joyproj');
    const reply = await service.open(copyKey);
    expect(reply).toMatchObject({
      kind: 'ready',
      claim: 'renewed',
      previousId: original.id,
      siblings: [{ key: original.key, name: 'Summer.joyproj' }],
    });
    if (reply.kind !== 'ready') throw new Error('expected a ready folder');
    expect(reply.id).not.toBe(original.id);

    // The original keeps its id, and the copy's listed entry shows the new one.
    const listed = await service.list();
    expect(listed.folders.find((folder) => folder.name === 'Summer.joyproj')?.entry?.id).toBe(
      original.id,
    );
    expect(listed.folders.find((folder) => folder.name === 'Summer copy.joyproj')?.entry?.id).toBe(
      reply.id,
    );
  });

  it('asks the owner which folder is the original when the registry has no record, and an original answer settles it', async () => {
    const first = serviceOn('claims-a.sqlite');
    const created = await first.create('Summer');
    if (created.kind !== 'created') throw new Error('expected a created folder');

    // A registry that has never heard of the folder: as after a lost registry file.
    const lost = serviceOn('claims-b.sqlite');
    const key = await keyOf(lost, 'Summer.joyproj');
    await expect(lost.open(key)).resolves.toEqual({
      kind: 'ask',
      ask: { reason: 'no-record', projectId: created.id, siblings: [] },
    });

    await expect(lost.answer(key, 'original')).resolves.toEqual({
      kind: 'answered',
      claim: 'claimed',
      siblings: [],
    });
    await expect(lost.open(key)).resolves.toMatchObject({ kind: 'ready', claim: 'kept' });
  });

  it('a copy answer on a folder with no record gives it a new id', async () => {
    const first = serviceOn('claims-a.sqlite');
    const created = await first.create('Summer');
    if (created.kind !== 'created') throw new Error('expected a created folder');

    const lost = serviceOn('claims-b.sqlite');
    const key = await keyOf(lost, 'Summer.joyproj');
    const reply = await lost.answer(key, 'copy');
    expect(reply).toMatchObject({ kind: 'answered', claim: 'renewed', previousId: created.id });
  });

  it('asks with the recorded place when the original has moved away, and lists the moved folder as a sibling', async () => {
    const service = serviceOn();
    const original = await service.create('Summer');
    if (original.kind !== 'created') throw new Error('expected a created folder');
    const recordedPlace = placeOf('Summer.joyproj');
    copyFolder('Summer.joyproj', 'Summer copy.joyproj');
    renameSync(join(directory, 'Summer.joyproj'), join(directory, 'Summer moved.joyproj'));

    const copyKey = await keyOf(service, 'Summer copy.joyproj');
    const reply = await service.open(copyKey);
    expect(reply).toMatchObject({
      kind: 'ask',
      ask: {
        reason: 'claimant-missing',
        projectId: original.id,
        recordedPath: recordedPlace,
        siblings: [{ name: 'Summer moved.joyproj' }],
      },
    });
    if (reply.kind !== 'ask') throw new Error('expected an ask');
    expect(reply.ask.recordedAt).toEqual(expect.any(String));

    // Settling the copy gives it a new id, because the original is still known under its old one.
    await expect(service.answer(copyKey, 'copy')).resolves.toMatchObject({
      kind: 'answered',
      claim: 'renewed',
      previousId: original.id,
    });
  });

  it('holds a folder that lost its entry, and restores it under the recorded id with the title given', async () => {
    const service = serviceOn();
    const original = await service.create('Summer');
    if (original.kind !== 'created') throw new Error('expected a created folder');
    const recordedPlace = placeOf('Summer.joyproj');
    await editFolderDatabase('Summer.joyproj', 'DELETE FROM project_folder_entry');

    const key = await keyOf(service, 'Summer.joyproj');
    const held = await service.open(key);
    expect(held).toMatchObject({
      kind: 'ask',
      ask: { reason: 'entry-missing', projectId: original.id, recordedPath: recordedPlace },
    });

    await expect(service.restore(key, '  Summer again  ')).resolves.toEqual({ kind: 'restored' });
    await expect(service.open(key)).resolves.toEqual({
      kind: 'ready',
      claim: 'kept',
      id: original.id,
      title: 'Summer again',
      siblings: [],
    });
  });

  it('refuses a restore with an empty title, and writes nothing', async () => {
    const service = serviceOn();
    await service.create('Summer');
    await editFolderDatabase('Summer.joyproj', 'DELETE FROM project_folder_entry');
    const key = await keyOf(service, 'Summer.joyproj');
    await expect(service.restore(key, '   ')).resolves.toEqual({
      kind: 'refused',
      code: 'no-title',
    });
    const folder = await openProjectFolder(join(directory, 'Summer.joyproj'));
    try {
      expect(readProjectFolderEntry(folder)).toBeUndefined();
    } finally {
      folder.close();
    }
  });

  it('refuses a folder whose stored entry cannot be read as damaged, and changes nothing in it', async () => {
    const service = serviceOn();
    await service.create('Summer');
    await editFolderDatabase(
      'Summer.joyproj',
      "UPDATE project_folder_entry SET entry_json = 'not json'",
    );
    const key = await keyOf(service, 'Summer.joyproj');
    await expect(service.open(key)).resolves.toEqual({ kind: 'refused', code: 'damaged' });

    const folder = await openProjectFolder(join(directory, 'Summer.joyproj'));
    try {
      const row = folder.database
        .prepare('SELECT entry_json FROM project_folder_entry WHERE id = 1')
        .get() as { entry_json: string };
      expect(row.entry_json).toBe('not json');
    } finally {
      folder.close();
    }
  });

  it('refuses a folder without a project database as not a folder', async () => {
    const service = serviceOn();
    mkdirSync(join(directory, 'Bare.joyproj'), { recursive: true });
    const key = await keyOf(service, 'Bare.joyproj');
    await expect(service.open(key)).resolves.toEqual({ kind: 'refused', code: 'not-a-folder' });
  });

  it('reports a folder that has been moved since it was listed as missing, with no write', async () => {
    const service = serviceOn();
    await service.create('Summer');
    const key = await keyOf(service, 'Summer.joyproj');
    renameSync(join(directory, 'Summer.joyproj'), join(base, 'Summer elsewhere.joyproj'));
    await expect(service.open(key)).resolves.toEqual({
      kind: 'unverifiable',
      reason: 'missing-folder',
    });
    expect(existsSync(join(base, 'Summer elsewhere.joyproj', 'project.sqlite'))).toBe(true);
  });

  it('refuses an answer or a restore for a key that was never listed', async () => {
    const service = serviceOn();
    await expect(service.answer('nope', 'original')).resolves.toEqual({
      kind: 'refused',
      code: 'unknown-folder',
    });
    await expect(service.restore('nope', 'Title')).resolves.toEqual({
      kind: 'refused',
      code: 'unknown-folder',
    });
  });
});

describe('the question about a moved original, by what is at the recorded place now', () => {
  it('says another folder is at the recorded place when one with a different identity is there', async () => {
    const service = serviceOn();
    const original = await service.create('Summer');
    if (original.kind !== 'created') throw new Error('expected a created folder');
    renameSync(join(directory, 'Summer.joyproj'), join(directory, 'Summer moved.joyproj'));
    copyFolder('Summer moved.joyproj', 'Summer copy.joyproj');
    // A different folder, with its own identity, now sits at the recorded place.
    copyFolder('Summer moved.joyproj', 'Summer.joyproj');

    const copyKey = await keyOf(service, 'Summer copy.joyproj');
    await expect(service.open(copyKey)).resolves.toMatchObject({
      kind: 'ask',
      ask: { reason: 'claimant-missing', placeState: 'other-folder', projectId: original.id },
    });
  });

  it('says the folder at the recorded place has changed, offers the original, and refuses a copy there', async () => {
    const service = serviceOn();
    const original = await service.create('Summer');
    if (original.kind !== 'created') throw new Error('expected a created folder');
    renameSync(join(directory, 'Summer.joyproj'), join(directory, 'Summer moved.joyproj'));
    // A restored backup now sits at the recorded place, with a new identity.
    copyFolder('Summer moved.joyproj', 'Summer.joyproj');

    const key = await keyOf(service, 'Summer.joyproj');
    await expect(service.open(key)).resolves.toMatchObject({
      kind: 'ask',
      ask: { reason: 'claimant-missing', placeState: 'this-folder', projectId: original.id },
    });
    await expect(service.answer(key, 'copy')).resolves.toEqual({
      kind: 'refused',
      code: 'identity-changed-at-place',
    });
    await expect(service.answer(key, 'original')).resolves.toEqual({
      kind: 'answered',
      claim: 'claimed',
      siblings: [],
    });
    await expect(service.open(key)).resolves.toMatchObject({ kind: 'ready', claim: 'kept' });
  });

  it('lists the folders that still hold the old id, when a copy is answered', async () => {
    const service = serviceOn();
    const original = await service.create('Summer');
    if (original.kind !== 'created') throw new Error('expected a created folder');
    copyFolder('Summer.joyproj', 'Summer copy.joyproj');
    const copyKey = await keyOf(service, 'Summer copy.joyproj');
    await expect(service.answer(copyKey, 'copy')).resolves.toMatchObject({
      kind: 'answered',
      claim: 'renewed',
      previousId: original.id,
      siblings: [{ key: original.key, name: 'Summer.joyproj' }],
    });
  });
});

describe('a default folder reached through a junction', () => {
  it.skipIf(process.platform !== 'win32')(
    'is still this folder at its recorded place, because the recorded place is a real path',
    async () => {
      const real = join(base, 'Real');
      const link = join(base, 'Link');
      mkdirSync(real);
      symlinkSync(real, link, 'junction');
      const linked = join(link, 'JOY Projects');
      const service = createProjectFolderService({
        registry: openProjectClaimRegistry(join(base, 'claims-junction.sqlite')),
        directory: linked,
      });
      services.push(service);
      const created = await service.create('Summer');
      if (created.kind !== 'created') throw new Error('expected a created folder');
      // The original moves away, and a copy with a new identity takes its recorded place.
      renameSync(join(linked, 'Summer.joyproj'), join(linked, 'Summer moved.joyproj'));
      cpSync(join(linked, 'Summer moved.joyproj'), join(linked, 'Summer.joyproj'), {
        recursive: true,
      });
      const key = await keyOf(service, 'Summer.joyproj');
      await expect(service.open(key)).resolves.toMatchObject({
        kind: 'ask',
        ask: { reason: 'claimant-missing', placeState: 'this-folder', projectId: created.id },
      });
    },
  );
});

describe('keys and places after a folder moves', () => {
  it('refuses an answer or a restore for a folder that is no longer where it was listed', async () => {
    const service = serviceOn();
    await service.create('Summer');
    const key = await keyOf(service, 'Summer.joyproj');
    renameSync(join(directory, 'Summer.joyproj'), join(base, 'Summer away.joyproj'));
    await expect(service.answer(key, 'original')).resolves.toEqual({
      kind: 'refused',
      code: 'missing-folder',
    });
    await expect(service.restore(key, 'Back')).resolves.toEqual({
      kind: 'refused',
      code: 'missing-folder',
    });
  });

  it('forgets the key of a folder that a later listing no longer finds under its old name', async () => {
    const service = serviceOn();
    await service.create('Summer');
    const oldKey = await keyOf(service, 'Summer.joyproj');
    renameSync(join(directory, 'Summer.joyproj'), join(directory, 'Summer2.joyproj'));
    await service.list();
    await expect(service.open(oldKey)).resolves.toEqual({
      kind: 'refused',
      code: 'unknown-folder',
    });
  });
});

describe('the worker message handler', () => {
  it('answers a message that is not a request with a fixed error', async () => {
    const service = serviceOn();
    await expect(handleProjectFolderMessage(service, { nope: true })).resolves.toEqual({
      id: -1,
      ok: false,
      error: 'Invalid project folder request',
    });
  });

  it('runs a list request and returns its value under the same id', async () => {
    const service = serviceOn();
    await expect(
      handleProjectFolderMessage(service, { id: 7, op: 'list', payload: {} }),
    ).resolves.toEqual({ id: 7, ok: true, value: { kind: 'listed', folders: [] } });
  });

  it('rejects a create request without a title, and an answer that is neither original nor copy', async () => {
    const service = serviceOn();
    await expect(
      handleProjectFolderMessage(service, { id: 8, op: 'create', payload: {} }),
    ).resolves.toEqual({ id: 8, ok: false, error: 'Invalid project folder request' });
    await expect(
      handleProjectFolderMessage(service, {
        id: 9,
        op: 'answer',
        payload: { key: 'key-1', answer: 'maybe' },
      }),
    ).resolves.toEqual({ id: 9, ok: false, error: 'Invalid project folder request' });
  });

  it('closes the registry on shutdown, so later registry work fails with a plain refusal', async () => {
    const service = serviceOn();
    await service.create('Summer');
    const key = await keyOf(service, 'Summer.joyproj');

    await expect(
      handleProjectFolderMessage(service, { id: 10, op: 'shutdown', payload: {} }),
    ).resolves.toEqual({ id: 10, ok: true, value: { kind: 'stopped' } });
    await expect(service.restore(key, 'Again')).resolves.toEqual({
      kind: 'refused',
      code: 'failed',
    });
  });
});
