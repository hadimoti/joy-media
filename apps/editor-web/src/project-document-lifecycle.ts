import type { ProjectDocumentV2 } from '@joy-media/project-schema';
import {
  migrateLegacyProjectDomains,
  type LegacyMigrationResult,
  type LegacyProjectDomains,
  type MigrationStorage,
} from './legacy-project-migration.js';
import {
  ProjectDocumentJournalError,
  type ProjectDocumentJournalRecovery,
  type ProjectDocumentLegacyBackup,
} from './project-document-browser-journal.js';

/** Minimal journal surface needed by the opening lifecycle. */
export interface ProjectDocumentOpeningJournal {
  recover(): Promise<ProjectDocumentJournalRecovery>;
  saveSnapshot(document: ProjectDocumentV2, options?: unknown): Promise<unknown>;
  saveLegacyBackup?(backup: ProjectDocumentLegacyBackup): Promise<void>;
  hasLegacyBackup?(): Promise<boolean>;
  loadLegacyBackup?(): Promise<ProjectDocumentLegacyBackup | null>;
}

export type ProjectDocumentOpeningResult =
  | {
      readonly kind: 'local';
      readonly recovery: ProjectDocumentJournalRecovery;
      readonly backupAvailable: boolean;
      readonly backupError?: unknown;
    }
  | {
      readonly kind: 'migrated';
      readonly document: ProjectDocumentV2;
      readonly migration: LegacyMigrationResult;
      readonly backupAvailable: true;
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'blocked'; readonly error: unknown };

/**
 * Opens a project without allowing a failed/corrupt journal read to fall
 * through into a destructive migration or opening save. Legacy migration is
 * deliberately attempted only for a typed, genuinely absent journal.
 */
export async function recoverOrMigrateProjectDocument(options: {
  readonly journal: ProjectDocumentOpeningJournal;
  readonly projectId: string;
  readonly legacyDomains: LegacyProjectDomains | null | undefined;
  readonly markerStorage?: MigrationStorage;
  readonly markerKey?: string;
}): Promise<ProjectDocumentOpeningResult> {
  try {
    const recovery = await options.journal.recover();
    let backupAvailable = false;
    let backupError: unknown;
    if (options.journal.hasLegacyBackup !== undefined) {
      try {
        backupAvailable = await options.journal.hasLegacyBackup();
      } catch (error) {
        backupError = error;
      }
    } else if (options.journal.loadLegacyBackup !== undefined) {
      // Compatibility for narrow test/host adapters predating availability
      // metadata; the App adapter always uses hasLegacyBackup above.
      try {
        backupAvailable = (await options.journal.loadLegacyBackup()) !== null;
      } catch (error) {
        backupError = error;
      }
    }
    return {
      kind: 'local',
      recovery,
      backupAvailable,
      ...(backupError === undefined ? {} : { backupError }),
    };
  } catch (error) {
    if (!isJournalNotFound(error)) return { kind: 'blocked', error };
  }

  let migration: LegacyMigrationResult;
  try {
    migration = await migrateLegacyProjectDomains(options.legacyDomains, {
      projectId: options.projectId,
      ...(options.markerStorage === undefined ? {} : { storage: options.markerStorage }),
      ...(options.markerKey === undefined ? {} : { markerKey: options.markerKey }),
    });
  } catch (error) {
    return { kind: 'blocked', error };
  }
  if (migration.status === 'no-data') return { kind: 'empty' };
  if (migration.status === 'invalid' || migration.document === undefined)
    return { kind: 'blocked', error: migration };

  // Write the backup first: if the V2 snapshot write fails, the user's
  // recoverable legacy copy is still durable in the same local backend.
  if (options.journal.saveLegacyBackup === undefined) {
    return {
      kind: 'blocked',
      error: new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_WRITE_FAILED',
        'local journal does not support durable legacy backups',
      ),
    };
  }
  try {
    await options.journal.saveLegacyBackup(migration.backup);
    await options.journal.saveSnapshot(migration.document, {
      operationKind: 'legacy-project-migration',
      operationMetadata: { digest: migration.digest ?? '', status: migration.status },
    });
  } catch (error) {
    return { kind: 'blocked', error };
  }
  return { kind: 'migrated', document: migration.document, migration, backupAvailable: true };
}

/** Build the same-origin download payload only after an explicit user action. */
export function legacyBackupBlob(backup: ProjectDocumentLegacyBackup): Blob {
  return new Blob([backup.content], { type: backup.mimeType });
}

/** A failed local recovery must keep the current session authoritative. */
export function shouldBootstrapFromRemoteAfterOpening(
  result: ProjectDocumentOpeningResult,
): boolean {
  return result.kind !== 'blocked';
}

/** A readable but invalid V2 document is still local recovery failure. */
export function shouldBootstrapFromRemoteAfterHydration(
  result: ProjectDocumentOpeningResult,
  hydrationAccepted: boolean,
): boolean {
  return hydrationAccepted && shouldBootstrapFromRemoteAfterOpening(result);
}

function isJournalNotFound(error: unknown): boolean {
  return error instanceof ProjectDocumentJournalError
    ? error.code === 'JOURNAL_NOT_FOUND'
    : typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'JOURNAL_NOT_FOUND';
}
