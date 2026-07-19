import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTransaction } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
import { validateSpikeProject } from '@joy-media/project-schema';
import type { SpikeProject } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import {
  InMemoryProjectStore,
  LocalProjectPersistence,
  PersistenceError,
  ProjectLockManager,
} from './persistence.js';
import type { PersistenceAdapter } from './persistence.js';
import { JsonFileProjectStore } from './desktop-store.js';

const adapter: PersistenceAdapter<SpikeProject, CommandTransaction> = {
  projectId: (project) => project.id,
  schemaVersion: (project) => project.schemaVersion,
  validate: validateSpikeProject,
  apply: (project, transaction) => applyTransaction(project, transaction).project,
};

function insert(id: string): CommandTransaction {
  return {
    label: `Insert ${id}`,
    commands: [
      {
        type: 'timeline.insertClip',
        payload: {
          compositionId: 'root',
          trackId: 'track-0',
          clip: makeVideoClip(id, 0, 1_000_000),
        },
      },
    ],
  };
}

describe('local project persistence', () => {
  it('reopens a verified snapshot plus command log', () => {
    const store = new InMemoryProjectStore<SpikeProject, CommandTransaction>();
    const persistence = new LocalProjectPersistence(store, adapter);
    const initial = emptySpikeProject();
    persistence.initialize(initial);
    const next = persistence.saveTransaction(initial, insert('clip-1'), true);
    expect(persistence.recover(initial.id)).toMatchObject({
      project: next,
      revision: 1,
      recoveredWithWarnings: false,
    });
    expect(persistence.autosaveState).toBe('saved-locally');
  });

  it('stops recovery at a truncated log entry and retains the last valid revision', () => {
    const store = new InMemoryProjectStore<SpikeProject, CommandTransaction>();
    const persistence = new LocalProjectPersistence(store, adapter);
    const initial = emptySpikeProject();
    persistence.initialize(initial);
    persistence.saveTransaction(initial, insert('clip-1'), false);
    store.corruptLastTransaction(initial.id);
    const recovered = persistence.recover(initial.id);
    expect(recovered).toMatchObject({ project: initial, revision: 0, recoveredWithWarnings: true });
    expect(recovered.warnings[0]).toMatch(/checksum/);
    expect(persistence.autosaveState).toBe('saved-locally-server-unavailable');
  });

  it('persists a desktop snapshot plus log across a fresh store instance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-persistence-'));
    const filePath = join(directory, 'project-store.json');
    const initial = emptySpikeProject();
    const first = new LocalProjectPersistence(
      new JsonFileProjectStore<SpikeProject, CommandTransaction>(filePath),
      adapter,
    );
    first.initialize(initial);
    const expected = first.saveTransaction(initial, insert('clip-1'), true);

    expect(existsSync(filePath)).toBe(true);
    const reopened = new LocalProjectPersistence(
      new JsonFileProjectStore<SpikeProject, CommandTransaction>(filePath),
      adapter,
    );
    expect(reopened.recover(initial.id)).toMatchObject({ project: expected, revision: 1 });
  });

  it('exposes the transient syncing and unavailable-server autosave states', () => {
    const persistence = new LocalProjectPersistence(
      new InMemoryProjectStore<SpikeProject, CommandTransaction>(),
      adapter,
    );
    persistence.beginSync();
    expect(persistence.autosaveState).toBe('syncing');
    persistence.completeSync(false);
    expect(persistence.autosaveState).toBe('saved-locally-server-unavailable');
    expect(() => persistence.completeSync(true)).toThrow(
      expect.objectContaining({ code: 'PERSISTENCE_SYNC_NOT_ACTIVE' }),
    );
  });

  it('keeps a write-ahead recovery copy when durable storage fails', () => {
    const store = new InMemoryProjectStore<SpikeProject, CommandTransaction>();
    const persistence = new LocalProjectPersistence(store, adapter);
    const initial = emptySpikeProject();
    persistence.initialize(initial);
    store.failNextWrite = true;
    expect(() => persistence.saveTransaction(initial, insert('clip-1'), true)).toThrow(
      PersistenceError,
    );
    expect(persistence.autosaveState).toBe('save-error-recovery-available');
    expect(persistence.recoveryCopy(initial.id)).toEqual(initial);
  });

  it('prevents two clients from editing the same local project', () => {
    const locks = new ProjectLockManager();
    locks.acquire('project-1', 'tab-a');
    expect(() => locks.acquire('project-1', 'tab-b')).toThrow(
      expect.objectContaining({ code: 'PERSISTENCE_PROJECT_LOCKED' }),
    );
    locks.release('project-1', 'tab-a');
    expect(() => locks.acquire('project-1', 'tab-b')).not.toThrow();
  });
});
