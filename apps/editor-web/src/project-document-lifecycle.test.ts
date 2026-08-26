import { describe, expect, it } from 'vitest';
import type { ProjectDocumentV2 } from '@joy-media/project-schema';
import {
  ProjectDocumentJournalError,
  ProjectDocumentBrowserJournal,
  type ProjectDocumentBrowserJournalStorage,
  type ProjectDocumentJournalRecovery,
} from './project-document-browser-journal.js';
import {
  legacyBackupBlob,
  recoverOrMigrateProjectDocument,
  shouldBootstrapFromRemoteAfterHydration,
  shouldBootstrapFromRemoteAfterOpening,
} from './project-document-lifecycle.js';

const project = {
  schemaVersion: 2 as const,
  projectId: 'project-a',
  project: { schemaVersion: 1, id: 'project-a', title: 'Legacy' },
  timeline: { id: 'project-a', clips: [] },
} as unknown as ProjectDocumentV2;

function storage(): ProjectDocumentBrowserJournalStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function openingJournal(
  recover: () => Promise<ProjectDocumentJournalRecovery>,
  saves: ProjectDocumentV2[],
  stored = storage(),
) {
  const journal = new ProjectDocumentBrowserJournal(stored, 'project-a');
  return {
    journal,
    opening: {
      recover,
      saveSnapshot: async (document: ProjectDocumentV2) => {
        saves.push(document);
        return journal.saveSnapshot(document);
      },
      saveLegacyBackup: (backup: Parameters<typeof journal.saveLegacyBackup>[0]) =>
        journal.saveLegacyBackup(backup),
      loadLegacyBackup: () => journal.loadLegacyBackup(),
    },
    stored,
  };
}

describe('project opening migration lifecycle', () => {
  it('does not permit remote hydration after blocked local recovery', () => {
    expect(
      shouldBootstrapFromRemoteAfterOpening({ kind: 'blocked', error: new Error('read failed') }),
    ).toBe(false);
    expect(shouldBootstrapFromRemoteAfterOpening({ kind: 'empty' })).toBe(true);
  });

  it('does not permit remote overwrite after a readable but invalid local V2 document', () => {
    expect(
      shouldBootstrapFromRemoteAfterHydration(
        {
          kind: 'local',
          recovery: { document: project, revision: 1, recoveredWithWarnings: false, warnings: [] },
          backupAvailable: false,
        },
        false,
      ),
    ).toBe(false);
    expect(shouldBootstrapFromRemoteAfterHydration({ kind: 'empty' }, true)).toBe(true);
  });

  it('lets a valid V2 journal win and skips legacy migration', async () => {
    const saves: ProjectDocumentV2[] = [];
    const existing = { document: project, revision: 1, recoveredWithWarnings: false, warnings: [] };
    const { opening } = openingJournal(async () => existing, saves);
    const result = await recoverOrMigrateProjectDocument({
      journal: opening,
      projectId: 'project-a',
      legacyDomains: { project: { stale: true } },
    });
    expect(result.kind).toBe('local');
    expect(saves).toEqual([]);
  });

  it('tracks backup availability without loading backup content during reopen', async () => {
    const existing = { document: project, revision: 1, recoveredWithWarnings: false, warnings: [] };
    const { opening } = openingJournal(async () => existing, []);
    const result = await recoverOrMigrateProjectDocument({
      journal: {
        ...opening,
        hasLegacyBackup: async () => true,
        loadLegacyBackup: async () => {
          throw new Error('backup content must be lazy');
        },
      },
      projectId: 'project-a',
      legacyDomains: null,
    });
    expect(result).toMatchObject({ kind: 'local', backupAvailable: true });
  });

  it('migrates legacy data once and persists both V2 and its backup', async () => {
    const saves: ProjectDocumentV2[] = [];
    const marker = new Map<string, string>();
    const first = openingJournal(async () => {
      throw new ProjectDocumentJournalError('JOURNAL_NOT_FOUND', 'missing');
    }, saves);
    const migrated = await recoverOrMigrateProjectDocument({
      journal: first.opening,
      projectId: 'project-a',
      legacyDomains: project,
      markerStorage: {
        getItem: (key) => marker.get(key) ?? null,
        setItem: (key, value) => void marker.set(key, value),
      },
    });
    expect(migrated.kind).toBe('migrated');
    expect(saves).toHaveLength(1);
    expect(marker.get('joy-media.legacy-project-migration.v2')).toMatch(/^[a-f0-9]{64}$/);
    const backup = await first.journal.loadLegacyBackup();
    expect(backup?.mimeType).toBe('application/json');
    expect(JSON.parse(await legacyBackupBlob(backup!).text())).toMatchObject({
      project: expect.any(Object),
    });

    const reopened = openingJournal(() => first.journal.recover(), [], first.stored);
    const second = await recoverOrMigrateProjectDocument({
      journal: reopened.opening,
      projectId: 'project-a',
      legacyDomains: { project: { changed: true } },
      markerStorage: {
        getItem: (key) => marker.get(key) ?? null,
        setItem: (key, value) => void marker.set(key, value),
      },
    });
    expect(second.kind).toBe('local');
    if (second.kind === 'local') expect(second.backupAvailable).toBe(true);
  });

  it('does not migrate or save after a journal read failure', async () => {
    const saves: ProjectDocumentV2[] = [];
    const readFailure = openingJournal(async () => {
      throw new ProjectDocumentJournalError('JOURNAL_STORAGE_READ_FAILED', 'denied');
    }, saves);
    const result = await recoverOrMigrateProjectDocument({
      journal: readFailure.opening,
      projectId: 'project-a',
      legacyDomains: project,
      markerStorage: { getItem: () => null, setItem: () => undefined },
    });
    expect(result.kind).toBe('blocked');
    expect(saves).toEqual([]);
  });
});
