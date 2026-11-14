import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTransaction } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
import {
  canonicalBindingKey,
  colorPropertyBinding,
  createIdentityColorGrade,
  migrateV0ToV1,
  validateJoyProjectV1,
  validateSpikeProject,
} from '@joy-media/project-schema';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import {
  InMemoryProjectStore,
  LocalProjectPersistence,
  PersistenceError,
  ProjectLockManager,
} from './persistence.js';
import type { PersistenceAdapter } from './persistence.js';
import { JsonFileProjectStore } from './desktop-store.js';
import { BrowserProjectStore } from './browser-store.js';

const adapter: PersistenceAdapter<SpikeProject, CommandTransaction> = {
  projectId: (project) => project.id,
  schemaVersion: (project) => project.schemaVersion,
  validate: validateSpikeProject,
  apply: (project, transaction) => applyTransaction(project, transaction).project,
};

const joyProjectAdapter: PersistenceAdapter<JoyProjectV1, CommandTransaction> = {
  projectId: (project) => project.id,
  schemaVersion: (project) => project.schemaVersion,
  validate: validateJoyProjectV1,
  apply: (project) => project,
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

/** Distinct start times so a run of inserts does not overlap itself. */
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

  it('reopens the saved output color grade from a desktop project snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-color-persistence-'));
    const filePath = join(directory, 'project-store.json');
    const identity = createIdentityColorGrade();
    const grade = {
      ...identity,
      adjust: {
        ...identity.adjust!,
        temperature: 0.4,
        tint: -0.2,
        exposure: 1,
        contrast: 0.3,
        pivot: 0.65,
        highlights: 0.35,
        shadows: -0.25,
        whites: 0.45,
        blacks: -0.4,
        saturation: 1.4,
        vibrance: 0.5,
        hue: 45,
      },
      lut: { builtIn: 'warm-cinema' as const, intensity: 0.6 },
    };
    const project: JoyProjectV1 = {
      ...migrateV0ToV1(emptySpikeProject()).project,
      colorGrade: grade,
    };

    new LocalProjectPersistence(
      new JsonFileProjectStore<JoyProjectV1, CommandTransaction>(filePath),
      joyProjectAdapter,
    ).initialize(project);

    const reopened = new LocalProjectPersistence(
      new JsonFileProjectStore<JoyProjectV1, CommandTransaction>(filePath),
      joyProjectAdapter,
    ).recover(project.id);
    expect(reopened.project.colorGrade).toEqual(grade);
  });

  /** Saves a project to a desktop snapshot file and reads it back through a fresh store. */
  function reopenDesktopProject(project: JoyProjectV1): JoyProjectV1 {
    const filePath = join(
      mkdtempSync(join(tmpdir(), 'joy-media-color-reopen-')),
      'project-store.json',
    );
    new LocalProjectPersistence(
      new JsonFileProjectStore<JoyProjectV1, CommandTransaction>(filePath),
      joyProjectAdapter,
    ).initialize(project);
    return new LocalProjectPersistence(
      new JsonFileProjectStore<JoyProjectV1, CommandTransaction>(filePath),
      joyProjectAdapter,
    ).recover(project.id).project;
  }

  it.each(['none', 'clean-contrast', 'soft-film', 'cool-fade', 'monochrome'] as const)(
    'reopens the %s look of the output grade with the same LUT intensity',
    (look) => {
      const grade = {
        ...createIdentityColorGrade(),
        lut: { builtIn: look, intensity: 0.7 },
      };
      const project: JoyProjectV1 = {
        ...migrateV0ToV1(emptySpikeProject()).project,
        colorGrade: grade,
      };
      expect(reopenDesktopProject(project).colorGrade).toEqual(grade);
    },
  );

  it('reopens clip grades, the saved keyframes and the output grade together', () => {
    const identity = createIdentityColorGrade();
    const outputGrade = {
      ...identity,
      adjust: { ...identity.adjust!, temperature: 0.4, exposure: -0.5, hue: 30 },
      lut: { builtIn: 'soft-film' as const, intensity: 0.8 },
    };
    const clipGrade = {
      ...identity,
      adjust: { ...identity.adjust!, tint: -0.2, saturation: 0.6 },
      lut: { builtIn: 'monochrome' as const, intensity: 0.4 },
    };
    const spike = emptySpikeProject();
    const root = spike.compositions[spike.rootCompositionId]!;
    const [firstTrack, ...otherTracks] = root.tracks;
    const withClip = {
      ...spike,
      compositions: {
        [root.id]: {
          ...root,
          tracks: [
            {
              ...firstTrack!,
              clips: [...firstTrack!.clips, makeVideoClip('clip-1', 0, 2_000_000)],
            },
            ...otherTracks,
          ],
        },
      },
    };

    // Keyframes are stored under their canonical binding keys, one per kind the panel writes.
    const outputTemperature = colorPropertyBinding('output', 'adjust.temperature');
    const outputHue = colorPropertyBinding('output', 'adjust.hue');
    const outputLook = colorPropertyBinding('output', 'lut.reference');
    const clipTint = colorPropertyBinding('clip', 'adjust.tint', 'clip-1');
    const propertyAnimations: NonNullable<JoyProjectV1['propertyAnimations']> = {
      [canonicalBindingKey(outputTemperature)]: {
        binding: outputTemperature,
        value: {
          kind: 'scalar',
          curve: { keyframes: [{ timeUs: 500_000, value: 0.4, interpolation: 'linear' }] },
        },
      },
      [canonicalBindingKey(outputHue)]: {
        binding: outputHue,
        value: {
          kind: 'hue',
          curve: { keyframes: [{ timeUs: 500_000, value: 30, interpolation: 'linear' }] },
        },
      },
      [canonicalBindingKey(outputLook)]: {
        binding: outputLook,
        value: {
          kind: 'string',
          keys: [
            { timeUs: 0, value: 'builtin:none' },
            { timeUs: 1_000_000, value: 'builtin:soft-film' },
          ],
        },
      },
      [canonicalBindingKey(clipTint)]: {
        binding: clipTint,
        value: {
          kind: 'scalar',
          curve: { keyframes: [{ timeUs: 250_000, value: -0.2, interpolation: 'linear' }] },
        },
      },
    };
    const project: JoyProjectV1 = {
      ...migrateV0ToV1(withClip).project,
      colorGrade: outputGrade,
      clipColorGrades: { 'clip-1': clipGrade },
      propertyAnimations,
    };

    const reopened = reopenDesktopProject(project);
    expect(reopened.colorGrade).toEqual(outputGrade);
    expect(reopened.clipColorGrades).toEqual({ 'clip-1': clipGrade });
    expect(reopened.propertyAnimations).toEqual(propertyAnimations);
  });

  it('persists a browser-local snapshot plus log across a fresh store instance', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const initial = emptySpikeProject();
    const first = new LocalProjectPersistence(
      new BrowserProjectStore<SpikeProject, CommandTransaction>(storage, 'timeline'),
      adapter,
    );
    first.initialize(initial);
    const expected = first.saveTransaction(initial, insert('clip-1'), false);
    const reopened = new LocalProjectPersistence(
      new BrowserProjectStore<SpikeProject, CommandTransaction>(storage, 'timeline'),
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

  it('reloads the second of two consecutive replacements', () => {
    // Snapshot revisions used to be derived from the transaction log alone, so
    // two replacements shared a revision and recovery picked the first.
    const store = new InMemoryProjectStore<SpikeProject, CommandTransaction>();
    const persistence = new LocalProjectPersistence(store, adapter);
    const initial = emptySpikeProject();
    persistence.initialize(initial);
    const once = applyTransaction(initial, insertAt('clip-1', 0)).project;
    const twice = applyTransaction(once, insertAt('clip-2', 1_000_000)).project;
    persistence.saveSnapshot(once, false);
    persistence.saveSnapshot(twice, false);
    expect(persistence.recover(initial.id).project).toEqual(twice);
  });

  it('replays a transaction written after a replacement', () => {
    const store = new InMemoryProjectStore<SpikeProject, CommandTransaction>();
    const persistence = new LocalProjectPersistence(store, adapter);
    const initial = emptySpikeProject();
    persistence.initialize(initial);
    const replaced = persistence.saveSnapshot(
      applyTransaction(initial, insertAt('clip-1', 0)).project,
      false,
    );
    const expected = persistence.saveTransaction(replaced, insertAt('clip-2', 1_000_000), false);
    expect(persistence.recover(initial.id).project).toEqual(expected);
  });

  it('keeps the snapshot log bounded and still recovers the newest', () => {
    const store = new InMemoryProjectStore<SpikeProject, CommandTransaction>();
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
    const store = new InMemoryProjectStore<SpikeProject, CommandTransaction>();
    const persistence = new LocalProjectPersistence(store, adapter);
    persistence.initialize(emptySpikeProject());
    expect(store.listProjectIds()).toEqual(['spike-project']);
  });
});
