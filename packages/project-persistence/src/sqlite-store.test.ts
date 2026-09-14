import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTransaction } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
import { validateSpikeProject } from '@joy-media/project-schema';
import type { SpikeProject } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import { LocalProjectPersistence } from './persistence.js';
import type { PersistenceAdapter } from './persistence.js';
import { SqliteProjectStore } from './sqlite-store.js';

const adapter: PersistenceAdapter<SpikeProject, CommandTransaction> = {
  projectId: (project) => project.id,
  schemaVersion: (project) => project.schemaVersion,
  validate: validateSpikeProject,
  apply: (project, transaction) => applyTransaction(project, transaction).project,
};

function insertAt(id: string, startUs: number): CommandTransaction {
  return {
    label: `Insert ${id}`,
    commands: [
      {
        type: 'timeline.insertClip',
        payload: {
          compositionId: 'root',
          trackId: 'track-0',
          clip: makeVideoClip(id, startUs, 1_000_000),
        },
      },
    ],
  };
}

describe('SqliteProjectStore', () => {
  it('persists a snapshot plus log across a fresh store instance opened on the same file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-sqlite-store-'));
    const filePath = join(directory, 'project-store.sqlite3');
    const initial = emptySpikeProject();

    const first = new LocalProjectPersistence(
      new SqliteProjectStore<SpikeProject, CommandTransaction>(filePath),
      adapter,
    );
    first.initialize(initial);
    const expected = first.saveTransaction(initial, insertAt('clip-1', 0), true);

    expect(existsSync(filePath)).toBe(true);
    const reopened = new LocalProjectPersistence(
      new SqliteProjectStore<SpikeProject, CommandTransaction>(filePath),
      adapter,
    );
    expect(reopened.recover(initial.id)).toMatchObject({ project: expected, revision: 1 });
  });

  it('keeps the snapshot log bounded and still recovers the newest', () => {
    const store = new SqliteProjectStore<SpikeProject, CommandTransaction>(':memory:');
    const persistence = new LocalProjectPersistence(store, adapter, 20, 3);
    const initial = emptySpikeProject();
    persistence.initialize(initial);
    let project = initial;
    for (let index = 0; index < 10; index++) {
      project = persistence.saveSnapshot(
        applyTransaction(project, insertAt(`clip-${index}`, index * 1_000_000)).project,
        false,
      );
    }
    expect(store.snapshots(initial.id)).toHaveLength(3);
    expect(persistence.recover(initial.id).project).toEqual(project);
  });

  it('lists project ids that have snapshots or transactions', () => {
    const store = new SqliteProjectStore<SpikeProject, CommandTransaction>(':memory:');
    const persistence = new LocalProjectPersistence(store, adapter);
    persistence.initialize(emptySpikeProject());
    expect(store.listProjectIds()).toEqual(['spike-project']);
  });

  it('deletes every snapshot and transaction for one project without touching others', () => {
    const store = new SqliteProjectStore<SpikeProject, CommandTransaction>(':memory:');
    const persistence = new LocalProjectPersistence(store, adapter);
    const project = emptySpikeProject();
    persistence.initialize(project);
    persistence.saveTransaction(project, insertAt('clip-1', 0), true);

    store.deleteProject(project.id);

    expect(store.snapshots(project.id)).toEqual([]);
    expect(store.transactions(project.id)).toEqual([]);
    expect(store.listProjectIds()).toEqual([]);
  });

  it('rolls a partially-written snapshot batch back on failure, leaving prior data intact', () => {
    const store = new SqliteProjectStore<SpikeProject, CommandTransaction>(':memory:');
    const project = emptySpikeProject();
    store.writeSnapshot(project.id, {
      payload: project,
      checksum: 'c0',
      revision: 0,
      schemaVersion: project.schemaVersion,
    });

    // A non-serializable payload (a BigInt) makes JSON.stringify throw mid-transaction; the
    // whole write must roll back rather than leave a partially-rewritten snapshot table.
    const poisoned = { ...project, id: project.id } as unknown as SpikeProject;
    Object.defineProperty(poisoned, 'poison', { value: 1n, enumerable: true });
    expect(() =>
      store.writeSnapshot(project.id, {
        payload: poisoned,
        checksum: 'c1',
        revision: 1,
        schemaVersion: project.schemaVersion,
      }),
    ).toThrow();

    expect(store.snapshots(project.id)).toHaveLength(1);
    expect(store.snapshots(project.id)[0]?.checksum).toBe('c0');
  });

  it('closes cleanly and rejects further use of the same handle', () => {
    const store = new SqliteProjectStore<SpikeProject, CommandTransaction>(':memory:');
    const project = emptySpikeProject();
    store.writeSnapshot(project.id, {
      payload: project,
      checksum: 'c0',
      revision: 0,
      schemaVersion: project.schemaVersion,
    });
    store.close();
    expect(() => store.listProjectIds()).toThrow();
  });
});
